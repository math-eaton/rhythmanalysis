# 🚀 Raspberry Pi Deployment Checklist

## One-Time Setup

```bash
# 1. Install Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker

# 2. Clone repository
git clone https://github.com/math-eaton/rhythmanalysis.git
cd rhythmanalysis

# 3. Configure environment
cp .env.template .env
nano .env  # Add your credentials

# 4. Build images (takes ~10 minutes on RPi)
docker compose build
```

## Every Update

```bash
cd ~/rhythmanalysis
git pull
docker compose build  # Only if Dockerfile changed
docker compose up -d
```

## Daily Operations

```bash
# Start
docker compose up -d

# Stop
docker compose down

# Restart single service
docker compose restart classify

# View logs (all services)
docker compose logs -f

# View logs (one service)
docker compose logs -f classify

# Check health
docker compose ps

# Check resources
docker stats
```

## Troubleshooting

```bash
# Audio device not found
docker compose exec classify ls -l /dev/snd

# Test MQTT connection
docker compose logs publish | grep -i mqtt

# Test database connection
docker compose logs publish | grep -i postgres

# View last 50 classification events
docker compose logs classify | tail -50

# Restart everything
docker compose down && docker compose up -d
```

## Files Changed from PM2 Setup

**New files:**
- `.env` - Environment configuration (secrets)
- `docker-compose.yml` - Service orchestration
- `containers/classify/` - Classifier container
- `containers/publish/` - Publisher container  
- `containers/api/` - API container
- `DOCKER.md` - Full documentation
- `verify_build.sh` - Build verification

**Keep using:**
- `scripts/rpi/pi_helper/check_wifi.*` - WiFi recovery (host-level)
- `scripts/models/yamnet/` - ML models (volume-mounted)
- `output/` - CSV backups (volume-mounted)

**Can archive:**
- `ecosystem.config.cjs` - PM2 config (replaced by docker-compose.yml)
- `start_classifying.sh` - PM2 startup (replaced by Docker)
- `start_publishing.sh` - PM2 startup (replaced by Docker)

## Quick Health Check

```bash
./verify_build.sh
```

## Emergency Rollback to PM2

```bash
docker compose down
pm2 resurrect  # If you saved PM2 config
# or
pm2 start ecosystem.config.cjs
```
