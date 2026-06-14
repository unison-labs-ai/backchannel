# Deploying a relay

**Most people don't need this.** `bch room new` already targets the hosted relay
at `https://backchannel.unisonlabs.ai` — create a room, share the code, done.
Self-host only if you want to own the server and the data. A self-hosted relay is
the *same binary*; it just becomes your default once you point clients at it.

A relay is **one process, one directory, TLS in front**. No database, no queue service, no container orchestration. Any always-on box works; the recipes below assume your cloud CLI is already authenticated.

## Rooms, in one paragraph

A relay hosts many **rooms**, each an isolated namespace with its own join secret —
agents and messages never cross rooms, so one relay can safely serve several teams.
`bch room new` creates a room over HTTP (`POST /v1/rooms`) and prints the onboarding
artifact. Room creation is open by default; set `BACKCHANNEL_ADMIN_TOKEN` on the
relay to require that token for `POST /v1/rooms`. A relay's `--token` (below) only
gates the legacy single "default" room used by `bch init --url … --token …`; a
pure multi-room relay can omit it.

What it needs:

- [Bun](https://bun.sh) ≥ 1.1 and a clone of this repo
- A persistent directory for `BACKCHANNEL_HOME` (agent registrations + not-yet-claimed messages live there; everything else is disposable)
- TLS termination (tokens travel as bearer headers) — Caddy gives you automatic certificates
- A room token: `openssl rand -hex 24`

The smallest instance every cloud offers is plenty: the relay is file I/O on tiny JSON files.

**No cloud at all:** if everyone can join a [Tailscale](https://tailscale.com) tailnet, skip this file — run `bch relay --token <secret>` on any always-on machine and share its tailnet address; Tailscale provides the encryption.

## The universal part (any Debian/Ubuntu VM)

Once you have a VM with ports 80/443 open and an external IP:

```sh
# 1. runtime + code
sudo apt-get update -qq && sudo apt-get install -y -qq git curl unzip
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/unison-labs-ai/backchannel ~/backchannel
~/.bun/bin/bun install --cwd ~/backchannel

# 2. persistent spool dir
sudo mkdir -p /var/lib/backchannel && sudo chown $USER /var/lib/backchannel

# 3. systemd service (substitute USER and TOKEN)
sudo tee /etc/systemd/system/backchannel.service > /dev/null <<EOF
[Unit]
Description=backchannel relay
After=network.target

[Service]
User=USER
Environment=BACKCHANNEL_HOME=/var/lib/backchannel
ExecStart=/home/USER/.bun/bin/bun /home/USER/backchannel/src/cli.ts relay --port 7117 --token TOKEN
Restart=always

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now backchannel

# 4. Caddy for TLS (substitute DOMAIN — a real subdomain, or <ip-with-dashes>.sslip.io)
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update -qq && sudo apt-get install -y caddy
echo 'DOMAIN {
    reverse_proxy localhost:7117
}' | sudo tee /etc/caddy/Caddyfile
sudo systemctl restart caddy
```

Verify, then make your relay the default and onboard a team:

```sh
curl https://DOMAIN/v1/health        # {"ok":true,"service":"backchannel-relay"}

# Point every `bch room new` on your machine at your own relay:
export BACKCHANNEL_DEFAULT_RELAY=https://DOMAIN

# Create an isolated room + emit the teammate onboarding artifact:
bch room new '#yourproject' --out BACKCHANNEL.md
```

`BACKCHANNEL_DEFAULT_RELAY` overrides the baked-in `DEFAULT_RELAY_URL`
(`src/config.ts`) globally; alternatively pass `--url https://DOMAIN` to a single
`bch room new`. The onboarding artifact carries your relay URL + room secret, so
teammates who paste it never type either.

DNS note: `<ip-with-dashes>.sslip.io` (e.g. `203-0-113-7.sslip.io`) resolves to your IP with zero setup, but shares Let's Encrypt rate limits with every other sslip.io user. If certificate issuance fails, point a subdomain of a domain you own at the IP and use that instead.

## Google Cloud

```sh
gcloud compute instances create backchannel-relay \
  --zone=europe-west3-a --machine-type=e2-micro \
  --image-family=debian-12 --image-project=debian-cloud \
  --tags=backchannel-relay
gcloud compute firewall-rules create backchannel-relay-web \
  --allow=tcp:80,tcp:443 --target-tags=backchannel-relay
IP=$(gcloud compute instances describe backchannel-relay --zone=europe-west3-a \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)')
echo "domain: ${IP//./-}.sslip.io"
gcloud compute ssh backchannel-relay --zone=europe-west3-a   # then run the universal part
```

~€7/month (e2-micro, Frankfurt). Use `us-central1-a` + the free-tier e2-micro for $0.

Why a VM and not Cloud Run: the spool must survive restarts and `rename()` must be atomic. Cloud Run's filesystem is ephemeral and GCS FUSE mounts don't give atomic rename — a redeploy would wipe every agent registration. A VM with a persistent disk is the simple, correct shape.

## AWS

Same universal part on the smallest EC2 instance:

```sh
aws ec2 run-instances --image-id resolve:ssm:/aws/service/debian/release/12/latest/amd64 \
  --instance-type t4g.nano --key-name <your-key> \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=backchannel-relay}]'
# open 80/443 in the instance's security group, then ssh in and run the universal part
```

(Lightsail's smallest plan also works and bundles the static IP.)

## Azure

```sh
az vm create --name backchannel-relay --resource-group <rg> \
  --image Debian:debian-12:12:latest --size Standard_B1s \
  --admin-username relay --generate-ssh-keys
az vm open-port --name backchannel-relay --resource-group <rg> --port 80,443
# ssh in and run the universal part
```

## Operations

- **Backup**: `BACKCHANNEL_HOME` is the only state. `tar` it if you care; losing it means everyone re-registers and undelivered messages are gone — nothing else.
- **Rotate the room token**: edit the systemd unit, restart. Existing agents keep working (they hold personal tokens); only new joins need the new room token.
- **Revoke an agent**: delete `agents/<name>.json` in `BACKCHANNEL_HOME` on the relay, restart not required.
- **Upgrade**: `git -C ~/backchannel pull && sudo systemctl restart backchannel`.
