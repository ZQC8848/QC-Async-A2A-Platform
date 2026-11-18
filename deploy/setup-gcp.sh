#!/bin/bash
# One-time GCP setup for the hub. Idempotent: safe to run again.
#
#   QCA2A_BILLING=<billing account id> deploy/setup-gcp.sh
#
# Every gcloud call names --project explicitly and nothing here runs `gcloud config set`,
# so the machine's default project (and anything deployed in other projects) is untouched.
set -euo pipefail
cd "$(dirname "$0")"
source ./env.sh

: "${QCA2A_BILLING:?set QCA2A_BILLING to the billing account id (gcloud billing accounts list)}"
exists() { "$@" >/dev/null 2>&1; }

echo "== project $PROJECT"
exists gcloud projects describe "$PROJECT" || gcloud projects create "$PROJECT" --name="QC-Async-A2A-Platform"
gcloud billing projects link "$PROJECT" --billing-account="$QCA2A_BILLING" >/dev/null

echo "== services"
gcloud services enable run.googleapis.com firestore.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com billingbudgets.googleapis.com --project="$PROJECT"

echo "== firestore ($REGION)"
gcloud firestore databases list --project="$PROJECT" --format='value(name)' | grep -q '(default)' || \
  gcloud firestore databases create --location="$REGION" --project="$PROJECT" >/dev/null

echo "== image repository"
exists gcloud artifacts repositories describe "$AR_REPO" --location="$REGION" --project="$PROJECT" || \
  gcloud artifacts repositories create "$AR_REPO" --repository-format=docker --location="$REGION" \
    --project="$PROJECT" --description="QC-Async-A2A hub images" >/dev/null

echo "== service account (Firestore access only)"
exists gcloud iam service-accounts describe "$SA" --project="$PROJECT" || \
  gcloud iam service-accounts create "${SA%%@*}" --project="$PROJECT" --display-name="QC-Async-A2A hub" >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" \
  --role=roles/datastore.user --condition=None >/dev/null

echo "== admin token"
# Generated once, stored in Secret Manager for the hub and in a 0600 file for the owner's
# `qca2a admin ...` commands. It is never printed.
if ! exists gcloud secrets describe admin-token --project="$PROJECT"; then
  mkdir -p "$(dirname "$ADMIN_FILE")" && chmod 700 "$(dirname "$ADMIN_FILE")"
  TOKEN=$(openssl rand -hex 32)
  printf '%s' "$TOKEN" | gcloud secrets create admin-token --project="$PROJECT" \
    --replication-policy=user-managed --locations="$REGION" --data-file=- >/dev/null
  (umask 077 && printf 'export QCA2A_ADMIN_TOKEN=%s\n' "$TOKEN" > "$ADMIN_FILE")
  unset TOKEN
  echo "   saved to $ADMIN_FILE"
fi
gcloud secrets add-iam-policy-binding admin-token --project="$PROJECT" \
  --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor >/dev/null

echo "== budget alert (\$5/month, this project only)"
NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
if ! gcloud billing budgets list --billing-account="$QCA2A_BILLING" --billing-project="$PROJECT" \
    --format='value(displayName)' 2>/dev/null | grep -qx "$PROJECT"; then
  gcloud billing budgets create --billing-account="$QCA2A_BILLING" --billing-project="$PROJECT" \
    --display-name="$PROJECT" --budget-amount=5USD --filter-projects="projects/$NUMBER" \
    --threshold-rule=percent=0.5 --threshold-rule=percent=1.0 >/dev/null \
    || echo "   could not create the budget; add it in the console (Billing -> Budgets & alerts)"
fi
echo "done. Next: deploy/deploy.sh"
