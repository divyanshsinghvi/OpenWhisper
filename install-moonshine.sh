#!/bin/bash

# Install Moonshine STT model with proper virtual environment management
# Uses uv (fast) or falls back to venv

set -e

VENV_DIR=".venv"

echo "🌙 Installing Moonshine STT Model"
echo "=================================="
echo ""

# Check if Python is installed
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 is not installed. Please install Python 3.8 or higher."
    exit 1
fi

# Function to install uv if not present
install_uv() {
    if ! command -v uv &> /dev/null; then
        echo "📦 Installing uv (fast Python package manager)..."
        curl -LsSf https://astral.sh/uv/install.sh | sh

        # Add to PATH for current session
        export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"

        if command -v uv &> /dev/null; then
            echo "✅ uv installed successfully"
            return 0
        else
            echo "⚠️  uv installation failed, will use standard venv"
            return 1
        fi
    else
        echo "✅ uv is already installed"
        return 0
    fi
}

# Check if we're already in an activated venv
if [ -n "$VIRTUAL_ENV" ]; then
    echo "✅ Already in virtual environment: $VIRTUAL_ENV"
    echo "📦 Installing useful-moonshine..."
    pip install useful-moonshine

elif [ -d "$VENV_DIR" ]; then
    # Venv exists but not activated
    echo "✅ Using existing virtual environment: $VENV_DIR"
    echo "📦 Installing useful-moonshine..."

    if install_uv; then
        # Use uv (faster)
        uv pip install --python "$VENV_DIR/bin/python3" useful-moonshine
    else
        # Use regular pip
        source "$VENV_DIR/bin/activate"
        pip install useful-moonshine
        deactivate
    fi

else
    # Create new venv
    if install_uv; then
        # Use uv to create venv (faster)
        echo "📦 Creating virtual environment with uv..."
        uv venv "$VENV_DIR"
        echo "📦 Installing useful-moonshine with uv..."
        uv pip install --python "$VENV_DIR/bin/python3" useful-moonshine
    else
        # Use standard venv
        echo "📦 Creating virtual environment with venv..."
        python3 -m venv "$VENV_DIR"
        source "$VENV_DIR/bin/activate"
        pip install --upgrade pip
        echo "📦 Installing useful-moonshine..."
        pip install useful-moonshine
        deactivate
    fi
fi

echo ""
echo "✅ Moonshine installed successfully!"
echo ""
echo "📁 Virtual environment: $VENV_DIR"
echo ""
echo "Model details:"
echo "- Package: useful-moonshine"
echo "- Speed: 5-15x faster than Whisper"
echo "- Size: Tiny (~40MB) and Base (~200MB) variants"
echo "- Optimized for edge/mobile devices"
echo ""
echo "⚠️  To use the model, activate the virtual environment:"
echo ""
echo "   source $VENV_DIR/bin/activate"
echo ""
echo "Or the app will automatically use it if you set:"
echo ""
echo "   export PATH=\"\$(pwd)/$VENV_DIR/bin:\$PATH\""
echo ""
echo "Next steps:"
echo "1. source $VENV_DIR/bin/activate"
echo "2. npm run build"
echo "3. npm start"
echo ""
