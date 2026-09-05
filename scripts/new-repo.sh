#!/usr/bin/env bash
# new-repo.sh — provision a new navigaite/edilio repo on the paved road.
#
# Usage: new-repo.sh <org>/<name> [--public]
#
# Automates everything GitHub-side that the template cannot carry:
#   repo from nvgt-repo-template, dev as default branch, merge-method settings,
#   auto-merge, branch rulesets (dev=squash, main=merge), Actions allowlist
#   safety, and prints the manual checklist (Infisical, Vercel, Flaiky).
set -euo pipefail
REPO="${1:?usage: new-repo.sh <org>/<name> [--public]}"
VIS="--private"; [ "${2:-}" = "--public" ] && VIS="--public"
ORG="${REPO%%/*}"; NAME="${REPO##*/}"

echo "==> 1/7 create from template"
gh repo create "$REPO" --template navigaite/nvgt-repo-template $VIS
sleep 5

echo "==> 2/7 default branch = dev"
gh api "repos/$REPO/branches" --jq '.[].name' | grep -qx dev || {
  msha=$(gh api "repos/$REPO/git/ref/heads/main" --jq .object.sha)
  gh api -X POST "repos/$REPO/git/refs" -f ref=refs/heads/dev -f sha="$msha" >/dev/null
}
gh api -X PATCH "repos/$REPO" -f default_branch=dev >/dev/null && echo "    dev is default"

echo "==> 3/7 repo settings"
gh api -X PATCH "repos/$REPO" -F delete_branch_on_merge=true -F allow_auto_merge=true \
  -F allow_squash_merge=true -F allow_merge_commit=true -F allow_rebase_merge=false >/dev/null \
  && echo "    auto-merge on, branch cleanup on, rebase off"

echo "==> 4/7 branch rulesets (dev=squash only, main=merge only)"
gh api -X POST "repos/$REPO/rulesets" --input - >/dev/null <<'JSON' && echo "    dev ruleset ok"
{"name":"dev: squash only","target":"branch","enforcement":"active",
 "conditions":{"ref_name":{"include":["refs/heads/dev"],"exclude":[]}},
 "rules":[{"type":"pull_request","parameters":{"allowed_merge_methods":["squash"],
  "dismiss_stale_reviews_on_push":false,"require_code_owner_review":false,
  "require_last_push_approval":false,"required_approving_review_count":0,
  "required_review_thread_resolution":true}}]}
JSON
gh api -X POST "repos/$REPO/rulesets" --input - >/dev/null <<'JSON' && echo "    main ruleset ok"
{"name":"main: merge only (promotions)","target":"branch","enforcement":"active",
 "conditions":{"ref_name":{"include":["refs/heads/main"],"exclude":[]}},
 "rules":[{"type":"pull_request","parameters":{"allowed_merge_methods":["merge"],
  "dismiss_stale_reviews_on_push":false,"require_code_owner_review":false,
  "require_last_push_approval":false,"required_approving_review_count":0,
  "required_review_thread_resolution":true}}]}
JSON

echo "==> 5/7 Actions allowlist safety"
mode=$(gh api "repos/$REPO/actions/permissions" --jq .allowed_actions)
if [ "$mode" = "selected" ]; then
  cur=$(gh api "repos/$REPO/actions/permissions/selected-actions")
  echo "$cur" | jq '.patterns_allowed += ["maxbec/pipeline/*"] | .patterns_allowed |= unique' \
    | gh api -X PUT "repos/$REPO/actions/permissions/selected-actions" --input - \
    && echo "    allowlist patched (maxbec/pipeline/*)"
else
  echo "    mode=$mode — nothing to patch (silent startup_failure trap avoided)"
fi

echo "==> 6/7 org secrets/vars sanity (must all say yes)"
for v in INFISICAL_IDENTITY_ID INFISICAL_DOMAIN PIPELINE_RUNNER; do
  gh api "orgs/$ORG/actions/variables/$v" --jq '"    org var " + .name + ": yes"' 2>/dev/null || echo "    org var $v: MISSING"
done

echo "==> 7/7 manual checklist (not automatable from here):"
cat <<EOF
    [ ] Infisical: create project (or folder in an existing product project),
        grant the 'Github' org identity Viewer, set repo vars:
          gh api -X POST repos/$REPO/actions/variables -f name=INFISICAL_PROJECT_SLUG -f value=<slug>
          gh api -X POST repos/$REPO/actions/variables -f name=INFISICAL_SECRET_PATH -f value=/<folder>
          (+ INFISICAL_ENV_SLUG / _PREVIEW_ / _PROD_ if not dev/staging/prod defaults)
    [ ] Vercel (if deploying): create project, set repo secrets
        VERCEL_TOKEN / VERCEL_ORG_ID / VERCEL_PROJECT_ID; set
        deployment.provider: vercel + vercel.scope in .github/pipeline.yaml
    [ ] Put the repository on the slim pipeline and register it in Flaiky:
        node provisioning/migrate-repos.ts --only $REPO --apply   (in maxbec/flaiky)
    [ ] Adjust .github/pipeline.yaml (stack, runtime, test/build commands)
EOF
echo "DONE — $REPO is on the paved road."
