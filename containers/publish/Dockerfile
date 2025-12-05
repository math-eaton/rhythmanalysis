# Lightweight Python container for MQTT-to-PostgreSQL bridge

FROM python:3.11-slim

# Install procps for health check
RUN apt-get update && apt-get install -y procps && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy requirements and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY publish.py .

# Set environment
ENV PYTHONUNBUFFERED=1

# Run the publisher script
CMD ["python", "-u", "publish.py"]
