FROM python:3.10-slim

# llama-cpp-python source থেকে build হওয়ার জন্য দরকারি টুলস
RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# CPU-only build নিশ্চিত করা (GPU backend ভুলে বিল্ড না হয়)
ENV CMAKE_ARGS="-DGGML_CUDA=off -DGGML_METAL=off"

WORKDIR /app

# আগে শুধু requirements কপি (layer caching এর জন্য — কোড বদলালে পুরো rebuild লাগবে না)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# বাকি সব কোড কপি করা
COPY . .

# HF Spaces শুধু 7860 পোর্ট এক্সপোজ করলেই "Running" দেখায়
EXPOSE 7860

# মডেল ডাউনলোড — build time এ করে রাখলে runtime এ বারবার লাগবে না
# (যদি model ফাইল আগে থেকেই repo তে না থাকে)
RUN bash download_model.sh

# HF Spaces container non-root user (UID 1000) হিসেবে রান করে,
# তাই /app এ write permission ঠিক রাখা লাগবে (মডেল ফাইল বা cache লেখার জন্য)
RUN chmod -R 777 /app

CMD ["uvicorn", "web_ui.app:app", "--host", "0.0.0.0", "--port", "7860"]
