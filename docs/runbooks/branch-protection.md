# Protect `main` so a broken build can never land on it

Today anyone with write access, including the access token stored in a developer's git remote, can push straight to `main`, and several pushes in October went red because nothing stopped them. GitHub can refuse such a push: a **ruleset** on `main` that requires a pull request and a green CI run before anything is merged. Only you (the repository owner) can switch it on; it takes about five minutes and costs nothing on a public repository.

Repository: https://github.com/macamisp/virtual-HR

## What it will do

- Nobody (including you) can push commits directly to `main`.
- Changes arrive through a **pull request** from another branch.
- The pull request can be merged only when the CI checks named **`test`** and **`terraform`** are green, and the branch contains the latest `main`.
- `main` cannot be deleted or rewritten (no force push).

The CI workflow also runs **`images`** and **`agent-installers`** after `test`; they build the container image and the desktop installers on three systems. They are not needed to protect `main` (add them later if you want the installers proven before every merge).

## Steps (GitHub website, as owner of the repository)

1. Open the repository → **Settings** (top row of tabs).
2. Left menu → **Rules** → **Rulesets**.
3. **New ruleset** → **New branch ruleset**.
4. **Ruleset name:** `Protect main`. **Enforcement status:** **Active**.
5. **Bypass list:** leave it **empty**. (If a rule ever blocks a real emergency, you can switch the ruleset to *Disabled* for a moment in this same screen, fix, and switch it back; be aware that this is possible, and that it is a deliberate act.)
6. **Target branches** → **Add target** → **Include default branch** (this is `main`).
7. Under **Branch rules**, tick:
   - **Restrict deletions**
   - **Block force pushes**
   - **Require a pull request before merging**. Set **Required approvals** to **0** while you are the only person (GitHub does not let you approve your own pull request; with 1 you could never merge). When a second person joins, change it to 1. Leave "Dismiss stale approvals" and the other sub-options at their defaults.
   - **Require status checks to pass**:
     - tick **Require branches to be up to date before merging**;
     - **Add checks** → type `test` and choose it, then type `terraform` and choose it. (A check appears in this list only after it has run once in the last week on this repository; both have.)
8. Click **Create**.
9. Settings → **General** → **Pull Requests** → tick **Automatically delete head branches** (keeps the branch list clean after a merge).

If you prefer the older screen: Settings → **Branches** → **Add branch protection rule** → branch name pattern `main` → tick *Require a pull request before merging*, *Require status checks to pass before merging* (add `test` and `terraform`, tick *Require branches to be up to date*), *Do not allow bypassing the above settings*, and make sure *Allow force pushes* and *Allow deletions* stay unticked.

## Check that it works

1. In a clone: `git switch -c try-protection`, change one character in `README.md`, commit, `git push origin try-protection`.
2. Try `git push origin HEAD:main`. GitHub refuses: *"Changes must be made through a pull request"*. That is the protection working.
3. On GitHub, open the pull request (the push prints a link), watch **test** and **terraform** run (about 20 minutes), and **Merge pull request** once both are green. Delete the test branch.

## How work flows afterwards

1. Work on a branch (`git switch -c feat/name`), commit, `git push origin feat/name`.
2. Open a pull request into `main` on GitHub (or with the GitHub command line, `gh pr create`, if installed). The CI runs on the pull request itself.
3. Red check: fix on the same branch and push again; the pull request updates. Green: **Merge**. Choose "Create a merge commit" or "Squash"; both keep history intact.
4. If `main` moved meanwhile, GitHub offers **Update branch**; click it and the checks run again.

Note for scripts and AI agents that push with a token stored in the git remote: the token needs the **Pull requests: write** permission (fine-grained token) to open pull requests, and direct pushes to `main` will now be refused, by design. That token was visible in a local git configuration during this project; **revoke it in GitHub → Settings → Developer settings → Personal access tokens and create a new one with the least access needed**.

## What this does not do

- It does not make the tests themselves reliable: a few timing-dependent tests can fail on a busy machine ([known-issues.md](../verification/known-issues.md), item 17). A failed check blocks the merge; re-run it from the pull request's **Checks** tab ("Re-run failed jobs") and, if the same test fails twice, treat it as real.
- It does not review the code. With one person, "approvals 0" means the green CI is the only gate.
- It does not stop someone with owner rights from changing or disabling the ruleset. GitHub records such changes in the repository's audit log, but nothing prevents them.
