import os
import json
from typing import List, Dict, Any

STACKS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stacks")

def ensure_stacks_dir():
    os.makedirs(STACKS_DIR, exist_ok=True)

def get_state_path(stack_name: str) -> str:
    ensure_stacks_dir()
    # Normalize stack name to prevent path traversal
    safe_name = "".join(c for c in stack_name if c.isalnum() or c in ("-", "_"))
    return os.path.join(STACKS_DIR, f"{safe_name}.json")

def save_stack_state(stack_name: str, resources: List[Dict[str, Any]], template: str = "", python_script: str = ""):
    ensure_stacks_dir()
    state = {
        "StackName": stack_name,
        "StackStatus": "CREATE_COMPLETE",
        "CreationTime": "2026-06-17T01:52:32Z",  # Mock or dynamic timestamp
        "Template": template,
        "PythonScript": python_script,
        "Resources": resources
    }
    path = get_state_path(stack_name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)

def load_stack_state(stack_name: str) -> Dict[str, Any]:
    path = get_state_path(stack_name)
    if not os.path.exists(path):
        raise FileNotFoundError(f"Stack '{stack_name}' state file not found.")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def delete_stack_state(stack_name: str):
    path = get_state_path(stack_name)
    if os.path.exists(path):
        os.remove(path)

def list_stacks() -> List[Dict[str, Any]]:
    ensure_stacks_dir()
    stacks = []
    for filename in os.listdir(STACKS_DIR):
        if filename.endswith(".json"):
            path = os.path.join(STACKS_DIR, filename)
            try:
                with open(path, "r", encoding="utf-8") as f:
                    state = json.load(f)
                    stacks.append({
                        "StackName": state.get("StackName"),
                        "StackStatus": state.get("StackStatus", "CREATE_COMPLETE"),
                        "CreationTime": state.get("CreationTime", "2026-06-17T01:52:32Z"),
                        "StackId": state.get("StackName")  # Use StackName as Id for simplicity
                    })
            except Exception:
                pass
    return stacks
