#!/bin/bash
# Path to the local node binary
LOCAL_NODE_BIN="$(pwd)/node20/bin"

if [ ! -d "$LOCAL_NODE_BIN" ]; then
    echo "❌ Local Node.js directory not found. Please ensure Node.js is installed in ./node20"
    exit 1
fi

export PATH="$LOCAL_NODE_BIN:$PATH"
echo "🚀 Starting Savor Final with Node $(node -v)..."
npm run dev
