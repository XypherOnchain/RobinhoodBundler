# Put NOXA on a server (stop killing your laptop)

Your wallets live in `data/*.json`. **Never delete that folder.** Always backup before moving.

| Process | Port | Data file |
|---------|------|-----------|
| Bundler | 3847 | `data/dashboard.json` |
| Sniper  | 3848 | `data/sniper.json` |
| TX Bot  | 3849 | `data/txbot.json` |

---

## Fastest path (about 20 minutes)

### 1) Buy a cheap VPS
- **Hetzner** CX22 / **DigitalOcean** $6 droplet / **Linode** Nanode  
- Ubuntu 22.04 or 24.04, **2 GB RAM** preferred  
- Note the IP + root (or sudo) login

### 2) On your Mac — backup + push

```bash
cd ~/Downloads/noxa-robinhood-bot

# Local backup of wallets (do this first)
bash scripts/backup-data.sh

# Push code + data to the server (replace with your login)
bash scripts/push-to-server.sh root@YOUR_SERVER_IP
```

### 3) On the server — install + start

```bash
ssh root@YOUR_SERVER_IP
cd /opt/noxa
bash scripts/server-setup.sh
```

That installs Node, starts all three bots with **pm2** (auto-restart if one crashes).

### 4) Use it from your Mac (SSH tunnel — recommended)

Leave bots private on the server. On your Mac:

```bash
ssh -N -L 3847:127.0.0.1:3847 -L 3848:127.0.0.1:3848 -L 3849:127.0.0.1:3849 root@YOUR_SERVER_IP
```

Then open:
- http://localhost:3847 — bundler  
- http://localhost:3848 — sniper  
- http://localhost:3849 — TX bot  

Same URLs as before; the work runs on the VPS.

### 5) Optional: real domain + HTTPS

Point DNS A records to the VPS IP, install Caddy:

```bash
sudo apt install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
bundler.yourdomain.com { reverse_proxy 127.0.0.1:3847 }
sniper.yourdomain.com  { reverse_proxy 127.0.0.1:3848 }
txbot.yourdomain.com   { reverse_proxy 127.0.0.1:3849 }
EOF
sudo systemctl reload caddy
```

**Put a password on it** (dashboards hold keys in memory / data files):

```
bundler.yourdomain.com {
  basicauth {
    admin $2a$14$REPLACE_WITH_CADDY_HASH
  }
  reverse_proxy 127.0.0.1:3847
}
```

Generate hash: `caddy hash-password`

Firewall: `ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable`

---

## After it’s on the server

**Stop local bots** so your laptop cools off:

```bash
# on Mac — kill local listeners
lsof -tiTCP:3847 -sTCP:LISTEN | xargs kill 2>/dev/null
lsof -tiTCP:3848 -sTCP:LISTEN | xargs kill 2>/dev/null
lsof -tiTCP:3849 -sTCP:LISTEN | xargs kill 2>/dev/null
```

Useful pm2 commands on the server:

```bash
pm2 status
pm2 logs noxa-bundler
pm2 restart all
```

Re-push updates later:

```bash
bash scripts/push-to-server.sh root@YOUR_SERVER_IP
ssh root@YOUR_SERVER_IP 'cd /opt/noxa && npm install --omit=dev && pm2 restart all'
```

---

## Safety

- `data/` has **private keys** — only scp/rsync over SSH, never Discord/email/git  
- Prefer SSH tunnel over public domain until you add basic auth  
- Keep `~/noxa-backups/` from `backup-data.sh` somewhere safe
