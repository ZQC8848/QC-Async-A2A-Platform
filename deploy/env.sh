# Shared by the deploy scripts. Override with environment variables.
PROJECT="${QCA2A_PROJECT:-qc-async-a2a-platform}"
REGION="${QCA2A_REGION:-us-west1}"
SERVICE=hub
AR_REPO=hub
SA="hub-run@${PROJECT}.iam.gserviceaccount.com"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/hub"
ADMIN_FILE="${QCA2A_HOME:-$HOME/.config/qca2a}/admin.env"
