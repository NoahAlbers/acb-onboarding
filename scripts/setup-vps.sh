#!/usr/bin/env bash
# ACB onboarding portal — one-shot VPS bootstrap (Ubuntu).
# Usage (as the default 'ubuntu' user on a fresh VPS):
#   curl -fsSL https://raw.githubusercontent.com/NoahAlbers/acb-onboarding/claude/beautiful-wozniak-emj3np/scripts/setup-vps.sh | bash
# Safe to re-run: every step is idempotent.
set -euo pipefail

BRANCH="claude/beautiful-wozniak-emj3np"
REPO="https://github.com/NoahAlbers/acb-onboarding"

echo "================================================="
echo "  ACB Client Onboarding — VPS setup"
echo "================================================="

# Prompts read from the terminal so this works when piped from curl.
read -rp "Portal domain (e.g. onboard.advancedcb.com): " DOMAIN < /dev/tty
if [ -z "$DOMAIN" ]; then echo "A domain is required — point its A record at this server first."; exit 1; fi
read -rp "DocuSeal API key (Enter to skip and use built-in signing): " DSKEY < /dev/tty

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a

echo "--- [1/5] System updates + basics"
sudo -E apt-get update -y
sudo -E apt-get upgrade -y
sudo -E apt-get install -y git ufw unattended-upgrades openssl

echo "--- [2/5] Firewall (22, 80, 443 only)"
sudo ufw allow OpenSSH >/dev/null
sudo ufw allow 80/tcp >/dev/null
sudo ufw allow 443/tcp >/dev/null
sudo ufw --force enable

echo "--- [3/5] Docker"
command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"

echo "--- [4/5] App checkout + configuration"
cd "$HOME"
if [ ! -d acb-onboarding ]; then git clone -b "$BRANCH" "$REPO"; fi
cd acb-onboarding
git fetch origin "$BRANCH" && git checkout "$BRANCH" && git pull --ff-only origin "$BRANCH"

if [ -f .env ]; then
  echo ".env already exists — leaving it untouched."
  ADMIN_KEY="(unchanged — see your existing .env)"
else
  ADMIN_KEY=$(openssl rand -hex 24)
  cat > .env <<ENV
DOMAIN=$DOMAIN
BASE_URL=https://$DOMAIN
ADMIN_KEY=$ADMIN_KEY
DOCUSEAL_API_KEY=$DSKEY
ENV
  chmod 600 .env
fi

echo "--- [5/5] Build + start (first build takes a couple of minutes)"
sudo docker compose up -d --build

echo
echo "================================================="
echo "  Done. Portal starting at: https://$DOMAIN"
echo "  (TLS is automatic once DNS points here)"
echo
echo "  Admin dashboard: https://$DOMAIN/admin"
echo "  Admin key:       $ADMIN_KEY"
echo "  ^ SAVE THIS KEY somewhere safe now."
echo
echo "  Check status:    sudo docker compose ps"
echo "  Watch logs:      sudo docker compose logs -f"
echo "  Update later:    cd ~/acb-onboarding && git pull && sudo docker compose up -d --build"
echo
echo "  FINAL HARDENING (do this from YOUR computer, not here):"
echo "    ssh-keygen -t ed25519        # if you have no key yet"
echo "    ssh-copy-id $USER@$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "    # confirm key login works, THEN disable passwords on the VPS:"
echo "    sudo sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config"
echo "    sudo systemctl restart ssh"
echo "================================================="
