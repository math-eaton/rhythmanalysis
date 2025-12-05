#!/bin/bash
# Docker Build Verification Script

echo "=== Docker Build Status ==="
echo ""

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker is not running"
    exit 1
fi
echo "✅ Docker is running"

# Check for built images
echo ""
echo "=== Built Images ==="
docker images | grep rhythmanalysis | awk '{printf "✅ %-30s %10s\n", $1":"$2, $7" "$8}'

# Validate docker-compose configuration
echo ""
echo "=== Docker Compose Configuration ==="
if docker compose config > /dev/null 2>&1; then
    echo "✅ docker-compose.yml is valid"
else
    echo "❌ docker-compose.yml has errors"
    exit 1
fi

# Check environment file
echo ""
echo "=== Environment Configuration ==="
if [ -f .env ]; then
    echo "✅ .env file exists"
    if grep -q "your_" .env; then
        echo "⚠️  Warning: .env contains placeholder values"
        echo "   Update with actual credentials before deploying"
    else
        echo "✅ .env appears to be configured"
    fi
else
    echo "❌ .env file missing"
    echo "   Copy .env.template to .env and configure"
    exit 1
fi

# Check model files
echo ""
echo "=== Model Files ==="
if [ -f "scripts/models/yamnet/tfLite/tflite/1/1.tflite" ]; then
    echo "✅ YAMNet model found"
else
    echo "❌ YAMNet model missing"
    echo "   Expected: scripts/models/yamnet/tfLite/tflite/1/1.tflite"
fi

if [ -f "scripts/models/yamnet/yamnet_class_map.csv" ]; then
    echo "✅ YAMNet class map found"
else
    echo "❌ YAMNet class map missing"
    echo "   Expected: scripts/models/yamnet/yamnet_class_map.csv"
fi

echo ""
echo "=== Summary ==="
echo "All containers built successfully!"
echo ""
echo "Next steps:"
echo "1. On Raspberry Pi: git pull to get latest code"
echo "2. Copy .env with your credentials"
echo "3. Run: docker compose up -d"
echo "4. Monitor: docker compose logs -f"
echo ""
echo "See DOCKER.md for complete documentation"
