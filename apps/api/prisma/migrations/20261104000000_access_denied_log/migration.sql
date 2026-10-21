-- AC-11: a refused look at a document is written to the access log (action ACCESS_DENIED).
ALTER TABLE document_access_logs DROP CONSTRAINT document_access_logs_action_check;
ALTER TABLE document_access_logs
  ADD CONSTRAINT document_access_logs_action_check CHECK (action IN (
    'VIEW', 'DOWNLOAD', 'UPLOAD', 'SHARE', 'DELETE', 'ACL_CHANGE', 'PASSWORD_FAIL', 'RECOVER', 'RESTORE', 'QUARANTINE', 'UPDATE',
    'SHRED', 'TRASH_RESTORE', 'LEGAL_HOLD', 'PASSWORD_SET', 'PASSWORD_REMOVED', 'REAUTH_REQUIRED', 'SIGN', 'ACCESS_DENIED'));
