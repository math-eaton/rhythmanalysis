# Quick Start: Docker Deployment

## Prerequisites
```bash
# Install Docker on Raspberry Pi
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker
```

## Setup
```bash
# 1. Clone repository
git clone https://github.com/math-eaton/rhythmanalysis.git
cd rhythmanalysis

# 2. Configure environment
cp .env.template .env
nano .env  # Edit with your credentials

# 3. Build images
docker compose build

# 4. Start services
docker compose up -d
```

## Common Commands

```bash
# View logs
docker compose logs -f

# Check status
docker compose ps

# Restart a service
docker compose restart classify

# Stop all
docker compose down

# View resource usage
docker stats
```

## Troubleshooting

```bash
# List audio devices
docker compose run --rm classify python classify.py --list-devices

# Check service health
docker compose ps

# View last 100 log lines
docker compose logs --tail=100

# Restart everything
docker compose down && docker compose up -d
```

## Auto-start on Boot

Services automatically restart on boot if Docker daemon is enabled:
```bash
sudo systemctl enable docker
```

---

See [DOCKER.md](./DOCKER.md) for complete documentation.
