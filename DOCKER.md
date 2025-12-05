# Docker Deployment Guide for Rhythmanalysis

This guide covers building and deploying the Rhythmanalysis audio classification system using Docker containers.

## Architecture

The system consists of three containerized services:

1. **classify** - Audio capture and ML inference (YAMNet model)
2. **publish** - MQTT-to-PostgreSQL bridge
3. **api** - Express.js REST API for data visualization

All services communicate via MQTT and share access to a cloud PostgreSQL database.

## Prerequisites

### Hardware
- Raspberry Pi 3B+ or newer (ARM64) for production
- x86_64 Mac/Linux for development
- USB microphone
- Internet connection for MQTT and PostgreSQL

### Software
- Docker Engine 20.10+
- Docker Compose 2.0+
- Git

### Installation on Raspberry Pi

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Add user to docker group
sudo usermod -aG docker $USER
newgrp docker

# Install Docker Compose
sudo apt install docker-compose-plugin

# Verify installation
docker --version
docker compose version
```

## Configuration

### 1. Clone Repository

```bash
git clone https://github.com/math-eaton/rhythmanalysis.git
cd rhythmanalysis
```

### 2. Set Environment Variables

Copy the template and edit with your credentials:

```bash
cp .env.template .env
nano .env
```

Update the following values:
- `MQTT_USERNAME` - Your HiveMQ Cloud username
- `MQTT_PASSWORD` - Your HiveMQ Cloud password
- `MQTT_BROKER` - Your HiveMQ broker URL
- `POSTGRES_URL` - Your PostgreSQL connection string
- `TZ` - Your timezone (e.g., `America/New_York`)

**Security Note:** Never commit `.env` to version control. It contains secrets.

## Building Images

### Option 1: Build on Target Device (Recommended for RPi)

On your Raspberry Pi:

```bash
# Build all services
docker compose build

# Or build individually
docker compose build classify
docker compose build publish
docker compose build api
```

### Option 2: Multi-Architecture Build (Advanced)

For building ARM images on x86 Mac/Linux using `buildx`:

```bash
# Set up buildx
docker buildx create --name multiarch --use
docker buildx inspect --bootstrap

# Build for ARM64 (Raspberry Pi 4/5)
docker buildx build \
  --platform linux/arm64 \
  -t rhythmanalysis-classify:arm64 \
  -f containers/classify/Dockerfile \
  containers/classify/ \
  --load

# Build for ARMv7 (Raspberry Pi 3)
docker buildx build \
  --platform linux/arm/v7 \
  -t rhythmanalysis-classify:armv7 \
  -f containers/classify/Dockerfile \
  containers/classify/ \
  --load
```

### Option 3: Cross-Compilation (Not Recommended)

Due to TensorFlow Lite's architecture-specific dependencies, cross-compilation may fail. Build natively on target hardware instead.

## Running the System

### Start All Services

```bash
# Start in detached mode
docker compose up -d

# View logs
docker compose logs -f

# View logs for specific service
docker compose logs -f classify
```

### Stop Services

```bash
# Stop all services
docker compose down

# Stop and remove volumes
docker compose down -v
```

### Restart Individual Service

```bash
docker compose restart classify
docker compose restart publish
docker compose restart api
```

## Audio Device Configuration

### List Available Audio Devices

```bash
docker compose run --rm classify python classify.py --list-devices
```

### Specify Audio Device

If you need a specific device (not the default USB mic):

```bash
# Edit docker-compose.yml and add to classify service:
environment:
  - AUDIO_DEVICE=1  # Use device index from --list-devices
```

Or modify `classify.py` to accept `AUDIO_DEVICE` environment variable.

## Monitoring

### Check Service Health

```bash
docker compose ps
```

Expected output:
```
NAME                      STATUS         PORTS
rhythmanalysis-api        Up (healthy)   0.0.0.0:3000->3000/tcp
rhythmanalysis-classify   Up (healthy)
rhythmanalysis-publish    Up (healthy)
```

### View Resource Usage

```bash
docker stats
```

### Check Logs

```bash
# All services
docker compose logs --tail=100 -f

# Specific service
docker compose logs classify --tail=50 -f

# Since specific time
docker compose logs --since 30m
```

## Data Persistence

### CSV Backups

Local CSV files are stored in `./output/classifications.csv` (mounted volume). This provides redundancy if the database is unavailable.

### Database

Data is persisted to PostgreSQL (Render Cloud). No local database storage needed.

## Troubleshooting

### Audio Device Not Found

```bash
# Check if container has device access
docker compose exec classify ls -l /dev/snd

# If empty, ensure device is connected and restart
docker compose restart classify
```

### MQTT Connection Failed

```bash
# Test MQTT credentials
docker compose exec publish python -c "
import paho.mqtt.client as mqtt
import ssl
client = mqtt.Client()
client.username_pw_set('$MQTT_USERNAME', '$MQTT_PASSWORD')
client.tls_set(tls_version=ssl.PROTOCOL_TLSv1_2)
client.connect('$MQTT_BROKER', 8883)
print('Connected!')
"
```

### Database Connection Failed

```bash
# Test PostgreSQL connection
docker compose exec publish python -c "
import psycopg2
from urllib.parse import urlparse
result = urlparse('$POSTGRES_URL')
conn = psycopg2.connect(
    dbname=result.path.lstrip('/'),
    user=result.username,
    password=result.password,
    host=result.hostname,
    port=result.port
)
print('Connected!')
"
```

### Memory Issues on Raspberry Pi

If services are being OOM-killed:

1. Check memory usage: `docker stats`
2. Reduce memory limits in `docker-compose.yml`
3. Close other applications
4. Consider disabling API service if not needed

### TensorFlow Lite Import Error

```bash
# Check which TFLite package is installed
docker compose exec classify python -c "
try:
    from ai_edge_litert.interpreter import Interpreter
    print('Using ai-edge-litert (ARM)')
except ImportError:
    from tensorflow.lite.python.interpreter import Interpreter
    print('Using tensorflow (x86)')
"
```

## Automatic Startup on Boot

### Using Docker Compose (Recommended)

Docker Compose services with `restart: unless-stopped` will auto-start on boot. Just ensure Docker daemon starts on boot:

```bash
sudo systemctl enable docker
```

### Using Systemd (Alternative)

Create `/etc/systemd/system/rhythmanalysis.service`:

```ini
[Unit]
Description=Rhythmanalysis Docker Compose
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/home/pi/rhythmanalysis
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
User=pi

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl enable rhythmanalysis
sudo systemctl start rhythmanalysis
```

## WiFi Recovery (Keep Host-Level)

The WiFi recovery script (`scripts/rpi/pi_helper/check_wifi.sh`) should remain as a host-level systemd timer, not containerized:

```bash
# Copy service files
sudo cp scripts/rpi/pi_helper/check_wifi.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/check_wifi.sh

sudo cp scripts/rpi/pi_helper/check_wifi.service /etc/systemd/system/
sudo cp scripts/rpi/pi_helper/check_wifi.timer /etc/systemd/system/

# Enable and start
sudo systemctl enable check_wifi.timer
sudo systemctl start check_wifi.timer
```

## Upgrading

### Pull Latest Code

```bash
cd ~/rhythmanalysis
git pull origin main
```

### Rebuild and Restart

```bash
docker compose down
docker compose build
docker compose up -d
```

### Zero-Downtime Restart (Individual Services)

```bash
# Update classifier without stopping publisher/API
docker compose build classify
docker compose up -d --no-deps classify
```

## Performance Tuning

### Raspberry Pi 3B+ Optimizations

1. **Reduce Model Threads**: Set `NUM_THREADS=1` in `.env` if CPU usage is too high
2. **Increase Flush Interval**: Modify `FLUSH_SEC` in `classify.py` to reduce disk writes
3. **Disable API**: Comment out `api` service in `docker-compose.yml` if not needed locally

### x86 Development Optimizations

1. **Use TensorFlow Full**: The Dockerfile automatically installs full TensorFlow on x86 for better performance
2. **Increase Threads**: Set `NUM_THREADS=4` or higher in `.env`

## Comparison with PM2

| Feature | PM2 | Docker |
|---------|-----|--------|
| Dependency isolation | ❌ System-wide | ✅ Per-container |
| Reproducibility | ⚠️ Manual setup | ✅ Dockerfile |
| Resource limits | ⚠️ Limited | ✅ Native support |
| Health checks | ⚠️ Basic | ✅ Built-in |
| Multi-arch support | ❌ Manual | ✅ buildx |
| Startup dependencies | ⚠️ Delays | ✅ depends_on |
| Log management | ✅ Good | ✅ Good |
| Memory overhead | ✅ Lower | ⚠️ Higher |

## Development Workflow

### Local Testing (Mac/Linux)

1. Install audio loopback device or use test audio file
2. Set up `.env` with same credentials
3. Run: `docker compose up`
4. Test API: `curl http://localhost:3000/api/audio_logs/count`

### Deploying to Production (Raspberry Pi)

1. Push code to GitHub
2. SSH to Raspberry Pi
3. Pull latest: `cd ~/rhythmanalysis && git pull`
4. Rebuild: `docker compose build`
5. Restart: `docker compose up -d`

## API Endpoints

Once running, the API is available at `http://localhost:3000`:

- `GET /api/audio_logs` - Query time-windowed events
  - Params: `offsetHours`, `binSeconds`, `start`, `end`, `timezone`
- `GET /api/audio_logs/count` - Total records and time range

## Backup Strategy

### CSV Backups

Automatic local backup every 30 seconds to `./output/classifications.csv`.

To archive:

```bash
# Copy from running container
docker compose cp classify:/app/output/classifications.csv ./backup_$(date +%Y%m%d).csv
```

### Database Backups

Your PostgreSQL provider (Render) should handle automatic backups. To manually export:

```bash
# From container
docker compose exec publish pg_dump $POSTGRES_URL > rhythmanalysis_$(date +%Y%m%d).dump
```

## Security Considerations

1. **Never commit `.env`** - Contains sensitive credentials
2. **Rotate passwords** - Change MQTT and database passwords periodically
3. **Use secrets** - For production, consider Docker Swarm secrets or Kubernetes
4. **Network isolation** - Containers use bridge network, not host
5. **Read-only mounts** - Model files are mounted read-only

## Support

For issues specific to:
- **Docker setup**: Check this guide
- **Audio/ML issues**: See original `readme.md`
- **PM2 migration**: Both systems can coexist during testing

## Migrating from PM2

### Side-by-Side Testing

PM2 and Docker can run simultaneously for comparison:

1. Stop PM2: `pm2 stop all`
2. Start Docker: `docker compose up -d`
3. Monitor both: Compare logs and resource usage
4. If Docker is stable, disable PM2: `pm2 delete all`

### Cleanup PM2 (Optional)

```bash
# Stop all processes
pm2 stop all
pm2 delete all

# Remove PM2
npm uninstall -g pm2

# Remove startup script
pm2 unstartup
```

### Keep PM2 as Backup

If you want PM2 as a fallback:

```bash
# Save PM2 config
pm2 save

# Just don't enable startup
# pm2 startup  # Don't run this
```

Then you can switch back with `pm2 resurrect` if needed.

## Future Enhancements

- [ ] Multi-sensor support (multiple RPi nodes)
- [ ] Local PostgreSQL container (eliminate cloud dependency)
- [ ] Prometheus metrics exporter
- [ ] Grafana dashboard
- [ ] S3 backup integration
- [ ] Model hot-swapping without restart

---

**Last Updated**: December 5, 2025  
**Docker Version**: 24.0+  
**Docker Compose Version**: 2.0+
