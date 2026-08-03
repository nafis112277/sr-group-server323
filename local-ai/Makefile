.PHONY: setup run test clean

VENV := .venv
PY := $(VENV)/bin/python
PIP := $(VENV)/bin/pip

setup:
	bash setup_venv.sh

run:
	$(PY) -m uvicorn web_ui.app:app --host 127.0.0.1 --port 8000 --reload

test:
	$(PY) -m pytest tests/ -v

clean:
	rm -rf $(VENV)
	find . -type d -name "__pycache__" -exec rm -rf {} +
	find . -type f -name "*.pyc" -delete
	rm -rf .pytest_cache
