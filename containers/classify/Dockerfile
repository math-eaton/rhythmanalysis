# Multi-architecture Dockerfile for audio classification
# Supports both x86_64 (development) and ARM (Raspberry Pi production)

FROM python:3.11-slim

# Install system dependencies for audio processing
RUN apt-get update && apt-get install -y \
    portaudio19-dev \
    libsndfile1 \
    alsa-utils \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies (base)
RUN pip install --no-cache-dir -r requirements.txt

# Install architecture-specific TensorFlow Lite
# For ARM (Raspberry Pi), use ai-edge-litert; for x86, use tensorflow-lite-runtime
ARG TARGETARCH
RUN if [ "$TARGETARCH" = "arm64" ] || [ "$TARGETARCH" = "arm" ]; then \
        pip install --no-cache-dir ai-edge-litert>=1.0.0; \
    else \
        pip install --no-cache-dir tensorflow>=2.14.0; \
    fi

# Copy application files
COPY classify.py .

# Create output directory
RUN mkdir -p /app/output

# Set environment variables
ENV PYTHONUNBUFFERED=1
ENV YAMNET_MODEL=/app/models/yamnet/tfLite/tflite/1/1.tflite
ENV CLASS_MAP_CSV=/app/models/yamnet/yamnet_class_map.csv
ENV OUTPUT_CSV=/app/output/classifications.csv
ENV NUM_THREADS=2

# Run the classification script
CMD ["python", "-u", "classify.py"]
