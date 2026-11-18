#!/bin/bash
# Build the hub image and deploy it to Cloud Run (create or update). Prints the hub URL.
# The service is public on the network; access control is the hub's own token check.
set -euo pipefail
cd "$(dirname "$0")"
source ./env.sh

TAG=$(date +%Y%m%d-%H%M%S)
gcloud builds submit ../hub --tag "$IMAGE:$TAG" --project="$PROJECT" --region="$REGION" --quiet

gcloud run deploy "$SERVICE" --image "$IMAGE:$TAG" --project="$PROJECT" --region="$REGION" \
  --service-account="$SA" --allow-unauthenticated \
  --set-env-vars="STORE=firestore,GCP_PROJECT=$PROJECT" \
  --set-secrets="ADMIN_TOKEN=admin-token:latest" \
  --memory=256Mi --cpu=1 --concurrency=40 --min-instances=0 --max-instances=2 --timeout=30 --quiet

URL=$(gcloud run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" --format='value(status.url)')
echo "hub: $URL"
curl -fsS "$URL/health" && echo
