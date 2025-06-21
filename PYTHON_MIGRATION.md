# Python Migration from Homebrew to Nix

## Migration Summary

Successfully migrated Python development environment from homebrew to nix-managed versions.

### Current Setup

- **Default Python**: Python 3.12 (current stable)
- **Core tools**: pip, virtualenv, pipenv, poetry
- **Development tools**: black, isort, mypy, ruff, pytest, ipython

### Environment Configuration

Added Python-specific environment variables:
- `PYTHONPATH`: User site-packages directory
- `PIP_USER`: Enable user-level pip installs
- `PYTHONDONTWRITEBYTECODE`: Prevent .pyc file creation
- `PYTHONUNBUFFERED`: Better logging output
- `POETRY_VENV_IN_PROJECT`: Poetry creates venvs in project directories

### Path Configuration

- Added `$HOME/.local/bin` to PATH for Python user packages
- Nix-managed Python is automatically available in PATH

### Useful Aliases

- `venv`: Create virtual environment (`python3 -m venv`)
- `activate`: Activate virtual environment (`source venv/bin/activate`)
- `py`: Python shorthand (`python3`)
- `pip3`: Use pip via Python module (`python3 -m pip`)

## Multiple Python Versions

### Available Versions

**Currently enabled:**
- `python312` (default, current stable)

**Available on-demand** (uncomment in development.nix):
- `python39` - For legacy projects
- `python311` - For compatibility needs
- `python313` - Use `pkgs.unstable.python313` for bleeding-edge

### Usage Examples

```bash
# Default Python (3.12)
python3 --version

# Multiple versions (when enabled)
python3.9 --version
python3.11 --version

# Using unstable channel for latest
nix shell nixpkgs-unstable#python313
```

### Project-Specific Versions

Use nix shells for project-specific Python versions:

```bash
# Enter shell with specific Python version
nix shell nixpkgs#python39 nixpkgs#python39Packages.pip

# Or create shell.nix for persistent project setup
cat > shell.nix << EOF
{ pkgs ? import <nixpkgs> {} }:
pkgs.mkShell {
  buildInputs = [
    pkgs.python39
    pkgs.python39Packages.pip
    pkgs.python39Packages.virtualenv
  ];
}
EOF
```

## Virtual Environment Integration

### Creating Virtual Environments

```bash
# Standard virtual environment
python3 -m venv myproject
cd myproject
source bin/activate

# Using the alias
venv myproject
cd myproject
activate
```

### Poetry Integration

Poetry is configured to create virtual environments in project directories:

```bash
# Initialize new project
poetry new myproject
cd myproject

# Install dependencies
poetry install

# Activate poetry shell
poetry shell
```

### Pipenv Integration

```bash
# Initialize Pipfile
pipenv --python 3.12

# Install packages
pipenv install requests

# Activate shell
pipenv shell
```

## Package Management

### User-level Packages

Pip is configured for user-level installs by default:

```bash
# Install user package
pip install --user package-name

# Packages install to ~/.local/lib/python3.12/site-packages
# Binaries install to ~/.local/bin (already in PATH)
```

### System Packages via Nix

For system-wide Python packages, add them to development.nix:

```nix
# In home.packages section
python312Packages.requests
python312Packages.numpy
python312Packages.pandas
```

## Development Tools

### Code Formatting

```bash
# Black (already installed)
black myfile.py

# isort (already installed)
isort myfile.py

# Ruff (fast linter/formatter)
ruff check myfile.py
ruff format myfile.py
```

### Type Checking

```bash
# MyPy (already installed)
mypy myfile.py
```

### Testing

```bash
# pytest (already installed)
pytest tests/
```

### Interactive Development

```bash
# IPython (enhanced REPL)
ipython
```

## Migration Testing

### Remove Homebrew Python Versions

After confirming nix setup works:

```bash
# List current homebrew python packages
brew list | grep python

# Remove homebrew versions
brew uninstall python@3.9 python@3.11 python@3.12 python@3.13
```

### Update Shell Environment

Remove homebrew Python from shell initialization if present:

```bash
# Check current PATH priority
echo $PATH | tr ':' '\n' | grep -E '(homebrew|python)'
```

## Troubleshooting

### Virtual Environment Issues

If virtual environments don't work correctly:

```bash
# Ensure Python has venv module
python3 -m venv --help

# Check Python installation
which python3
python3 --version
```

### Package Installation Issues

If pip packages fail to install:

```bash
# Check pip configuration
pip config list

# Install with explicit user flag
pip install --user --upgrade package-name
```

### Missing Development Tools

If tools like black, mypy are not found:

```bash
# Check tool availability
which black
which mypy
which ruff

# Should show nix store paths, not homebrew
```

## Next Steps

1. **Test virtual environments**: Create and test Python virtual environments
2. **Verify development tools**: Ensure black, mypy, ruff work correctly
3. **Remove homebrew Python**: After confirming everything works
4. **Update existing projects**: Test existing Python projects with new setup
5. **Document project-specific needs**: Add shell.nix files for projects requiring specific versions
