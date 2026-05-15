#!/bin/bash

# Install NVIDIA Parakeet Unified - fast, streaming-capable STT model
# Fixed for WSL2/Ubuntu system package conflicts

set -e

echo "🚀 Installing NVIDIA Parakeet Unified EN 0.6B"
echo "========================================"
echo ""
echo "Performance: offline + streaming-capable English ASR"
echo "Accuracy: ~5.91% offline WER on NVIDIA's reported benchmark"
echo "Language: English"
echo ""

# Check if Python is installed
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 is not installed. Please install Python 3.8 or higher."
    exit 1
fi

# Use --user to avoid system package conflicts
export PIP_USER=1

echo "📦 Upgrading pip (user installation)..."
pip3 install --user --upgrade pip

echo "📦 Installing PyTorch (default CUDA 12.8 version)..."
pip3 install --user torch torchaudio

echo "📦 Installing Cython..."
pip3 install --user Cython

echo "📦 Installing NeMo ASR (this will take several minutes)..."
# Install NeMo directly without trying to resolve all dependencies at once
pip3 install --user nemo_toolkit[asr]

echo ""
echo "✅ Parakeet TDT installation complete!"
echo ""
echo "Model details:"
echo "- Name: nvidia/parakeet-unified-en-0.6b"
echo "- Size: ~600MB (downloads on first use)"
echo "- Accuracy: ~5.91% offline WER"
echo "- Language: English"
echo ""
echo "⚠️  Important: Make sure ~/.local/bin is in your PATH"
echo "Add to ~/.bashrc if needed:"
echo 'export PATH="$HOME/.local/bin:$PATH"'
echo ""
echo "First transcription will download the model automatically."
echo ""
echo "Next steps:"
echo "1. source ~/.bashrc  # If you added PATH"
echo "2. npm install"
echo "3. npm run build"
echo "4. npm start"
echo ""
echo "Parakeet will be auto-selected for maximum speed!"
