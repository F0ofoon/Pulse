# ProxMox Pulse

A lightweight, responsive ProxMox monitoring application that displays real-time metrics for CPU, memory, network, and disk usage across multiple nodes.

![Dashboard](docs/images/dashboard.png)
*Main dashboard showing node overview and resource usage*

## 🚀 Quick Start with Docker

### Option 1: Simple Docker Run (Recommended for most users)

```bash
# 1. Download the example environment file
curl -O https://raw.githubusercontent.com/rcourtman/pulse/main/.env.example
mv .env.example .env

# 2. Edit the .env file with your ProxMox details
nano .env  # or use your preferred editor

# 3. Run with Docker
docker run -d \
  -p 7654:7654 \
  --env-file .env \
  --name pulse-app \
  --restart unless-stopped \
  rcourtman/pulse:latest

# 4. Access the application
# Open http://localhost:7654 in your browser
```

### Option 2: Docker Compose

```bash
# 1. Download the example files
curl -O https://raw.githubusercontent.com/rcourtman/pulse/main/.env.example
curl -O https://raw.githubusercontent.com/rcourtman/pulse/main/docker-compose.yml
mv .env.example .env

# 2. Edit the .env file with your ProxMox details
nano .env  # or use your preferred editor

# 3. Run with Docker Compose
docker-compose up -d

# 4. Access the application
# Open http://localhost:7654 in your browser
```

## 🔧 Configuration

### Required Environment Variables

Edit your `.env` file with at least these settings:

```bash
# Required: ProxMox Node Configuration
PROXMOX_NODE_1_NAME=Proxmox Node 1
PROXMOX_NODE_1_HOST=https://proxmox.local:8006
PROXMOX_NODE_1_TOKEN_ID=root@pam!pulse
PROXMOX_NODE_1_TOKEN_SECRET=your-token-secret
```

### ProxMox API Token Requirements

Your ProxMox API token needs these permissions:
- PVEAuditor role or custom role with:
  - Datastore.Audit
  - VM.Audit
  - Sys.Audit
  - Pool.Audit

## 🛠️ Common Docker Commands

```bash
# View logs
docker logs pulse-app

# Restart the application
docker restart pulse-app

# Update to latest version
docker pull rcourtman/pulse:latest
docker rm -f pulse-app
docker run -d -p 7654:7654 --env-file .env --name pulse-app --restart unless-stopped rcourtman/pulse:latest
```

## ✨ Features

- Real-time monitoring of ProxMox nodes, VMs, and containers
- Dashboard with summary cards for nodes, guests, and resources
- Responsive design that works on desktop and mobile
- WebSocket connection for live updates

## 📱 More Screenshots

### Resource Details
![Resources](docs/images/resources.png)
*Detailed resource monitoring with real-time graphs*

### Mobile View
![Mobile](docs/images/mobile.png)
*Responsive mobile interface*

## ❓ Troubleshooting

1. **Connection Issues**: Verify your ProxMox node details in `.env`
2. **SSL Problems**: Add these to your .env file:
   ```
   IGNORE_SSL_ERRORS=true
   NODE_TLS_REJECT_UNAUTHORIZED=0
   ```
3. **Port Conflicts**: Change the port mapping in your docker run command if port 7654 is already in use

## 📋 Advanced Configuration

For multiple ProxMox nodes or advanced settings, add these to your `.env`:

```bash
# Additional nodes
PROXMOX_NODE_2_NAME=Proxmox Node 2
PROXMOX_NODE_2_HOST=https://proxmox2.local:8006
PROXMOX_NODE_2_TOKEN_ID=root@pam!pulse
PROXMOX_NODE_2_TOKEN_SECRET=your-token-secret

# App Configuration
PORT=7654
LOG_LEVEL=info
METRICS_HISTORY_MINUTES=60
NODE_POLLING_INTERVAL_MS=1000
EVENT_POLLING_INTERVAL_MS=1000
```

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.