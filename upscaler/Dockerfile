FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive PORT=3000
# nodejs: tiny job server; mesa-vulkan-drivers provides lavapipe (software Vulkan) so no GPU is needed
RUN apt-get update && apt-get install -y --no-install-recommends \
      nodejs mesa-vulkan-drivers libvulkan1 libgomp1 curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Real-ESRGAN ncnn-vulkan release binary + only the models we use
RUN mkdir -p /opt/realesrgan/models /tmp/r \
    && curl -fsSL -o /tmp/r.zip https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-ubuntu.zip \
    && unzip -q /tmp/r.zip -d /tmp/r \
    && cp /tmp/r/realesrgan-ncnn-vulkan /opt/realesrgan/ \
    && cp /tmp/r/models/realesr-animevideov3-x* /tmp/r/models/realesrgan-x4plus.* /opt/realesrgan/models/ \
    && chmod +x /opt/realesrgan/realesrgan-ncnn-vulkan \
    && rm -rf /tmp/r /tmp/r.zip
WORKDIR /app
COPY server.js .
EXPOSE 3000
CMD ["node", "server.js"]
