#!/usr/bin/env bash
# Restore drill (ADR 020, SRS 12): restore the latest point-in-time backup of the database into a
# TEMPORARY instance, verify it with a read-only ECS task, record RTO/RPO, delete the copy.
#
# Run by an operator, with credentials for the target account, ONLY after approval. Staging by
# default; production needs --production (it only creates and deletes a temporary copy, but it
# still runs in the production account).
#
#   infra/scripts/restore-drill.sh --env staging [--keep]
set -euo pipefail

ENV=staging; KEEP=false; ALLOW_PROD=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV="$2"; shift 2 ;;
    --keep) KEEP=true; shift ;;
    --production) ALLOW_PROD=true; shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[[ "$ENV" == staging || "$ENV" == production ]] || { echo "--env staging|production" >&2; exit 2; }
[[ "$ENV" == production && "$ALLOW_PROD" != true ]] && { echo "Refusing production without --production." >&2; exit 2; }

REGION=ap-southeast-1
NAME="hrvo-$ENV"
DRILL="$NAME-drill-$(date -u +%Y%m%d%H%M)"
aws() { command aws --region "$REGION" "$@"; }

echo "Account: $(aws sts get-caller-identity --query Account --output text)   source: $NAME   copy: $DRILL"
read -r -p "Type the environment name to continue: " CONFIRM
[[ "$CONFIRM" == "$ENV" ]] || { echo "Cancelled."; exit 1; }

SRC=$(aws rds describe-db-instances --db-instance-identifier "$NAME" --query 'DBInstances[0]' --output json)
SG=$(jq -r '.VpcSecurityGroups[0].VpcSecurityGroupId' <<<"$SRC")
SUBNETS=$(jq -r '.DBSubnetGroup.DBSubnetGroupName' <<<"$SRC")
PARAMS=$(jq -r '.DBParameterGroups[0].DBParameterGroupName' <<<"$SRC")
LATEST=$(aws rds describe-db-instances --db-instance-identifier "$NAME" --query 'DBInstances[0].LatestRestorableTime' --output text)

START=$(date -u +%s)
echo "Restoring to the latest restorable time $LATEST ..."
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier "$NAME" --target-db-instance-identifier "$DRILL" \
  --use-latest-restorable-time --db-instance-class db.t4g.medium --no-multi-az \
  --db-subnet-group-name "$SUBNETS" --vpc-security-group-ids "$SG" --db-parameter-group-name "$PARAMS" \
  --no-publicly-accessible --no-deletion-protection --tags Key=Purpose,Value=restore-drill >/dev/null
cleanup() {
  if [[ "$KEEP" != true ]]; then
    echo "Deleting the temporary copy $DRILL ..."
    aws rds delete-db-instance --db-instance-identifier "$DRILL" --skip-final-snapshot --delete-automated-backups >/dev/null || true
  fi
}
trap cleanup EXIT
aws rds wait db-instance-available --db-instance-identifier "$DRILL"
READY=$(date -u +%s)
HOST=$(aws rds describe-db-instances --db-instance-identifier "$DRILL" --query 'DBInstances[0].Endpoint.Address' --output text)

CLUSTER="$NAME"
SUBNET_IDS=$(aws ec2 describe-subnets --filters "Name=tag:Environment,Values=$ENV" "Name=tag:Tier,Values=private" --query 'Subnets[].SubnetId' --output text | tr '\t' ',')
TASK_SG=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=$NAME-tasks" --query 'SecurityGroups[0].GroupId' --output text)
OVERRIDES=$(jq -nc --arg host "$HOST" '{containerOverrides: [{name: "migrate", command: ["node", "docker/restore-verify.mjs"], environment: [{name: "PGHOST", value: $host}, {name: "PGUSER", value: "hrvo_app"}]}]}')
TASK=$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$NAME-migrate" --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_IDS],securityGroups=[$TASK_SG],assignPublicIp=DISABLED}" \
  --overrides "$OVERRIDES" --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK"
CODE=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" --query 'tasks[0].containers[0].exitCode' --output text)
DONE=$(date -u +%s)

echo "------------------------------------------------------------------"
echo "Restore point:          $LATEST"
echo "Restore time (RTO):     $(( (READY - START) / 60 )) min to an available copy, $(( (DONE - START) / 60 )) min including verification"
echo "Verification exit code: $CODE  (details: CloudWatch log group /hrvo/$ENV/migrate)"
echo "Record the result in docs/runbooks/restore-drill.md (drill log)."
[[ "$CODE" == 0 ]]
