#!/bin/sh
# Monthly restore test: decrypt the newest backup, open it with SQLite, run an integrity check and count the data,
# then append the result to /results/restore-tests.log. Runs in the app image (node + node:sqlite).
set -eu
f=$(ls -1t /backups/klquiz-prod_*.db.enc 2>/dev/null | head -1)
[ -n "$f" ] || { echo "RESTORE TEST FAILED: no backup found"; exit 1; }
echo "testing $(basename "$f")"
node /scripts/backup-encrypt.js decrypt "$f" /work/restored.db
r=$(node -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync("/work/restored.db", { readOnly: true });
  const ok = db.prepare("PRAGMA integrity_check").get().integrity_check;
  const n = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  console.log(`${ok}|${n("questions")} questions, ${n("exam_templates")} patterns, ${n("tests")} tests, ${n("students")} students, ${n("attempts")} attempts`);
')
case "$r" in
  ok\|*) line="RESTORE TEST OK $(date -u -d "@$(( $(date +%s) + 19800 ))" '+%F %T') IST $(basename "$f"): ${r#ok|}" ;;
  *) echo "RESTORE TEST FAILED: $r"; exit 1 ;;
esac
echo "$line"; echo "$line" >> /results/restore-tests.log
