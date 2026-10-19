#!/usr/bin/env bash
# Publishes this folder to YOUR GitHub account as a PUBLIC repo named "claude-mods"
# (first time), or pushes your latest changes (every time after that).
set -euo pipefail
cd "$(dirname "$0")"

command -v gh >/dev/null || { echo "Install the GitHub CLI first:  brew install gh"; exit 1; }
gh auth status >/dev/null 2>&1 || gh auth login

USER_NAME="$(gh api user --jq .login)"
REPO="$USER_NAME/claude-mods"
echo "GitHub account: $USER_NAME   →   https://github.com/$REPO"

# put your username into the install lines
for f in $(grep -rl "YOUR_GITHUB_USERNAME" --include=*.md . || true); do
  sed -i '' "s/YOUR_GITHUB_USERNAME/$USER_NAME/g" "$f"
done

# check every mod before publishing
for dir in */; do
  [ -f "$dir.claude-plugin/plugin.json" ] && claude plugin validate "$dir"
done
claude plugin validate .

[ -d .git ] || git init -q -b main

# link to the GitHub repo if it already exists
if ! git remote get-url origin >/dev/null 2>&1 && gh repo view "$REPO" >/dev/null 2>&1; then
  git remote add origin "https://github.com/$REPO.git"
  git fetch -q origin main && git reset -q --soft origin/main
fi

git add -A
git status --short
git commit -qm "${1:-Update mods}" || echo "(nothing new to commit)"

if git remote get-url origin >/dev/null 2>&1; then
  git push -u origin main
else
  gh repo create "$REPO" --public --source . --push --description "Free, open mods for Claude Code"
fi

echo
echo "Done! https://github.com/$REPO"
echo "Anyone can now install:"
for name in $(python3 -c "import json;print(' '.join(p['name'] for p in json.load(open('.claude-plugin/marketplace.json'))['plugins']))"); do
  echo "  /plugin install $name --marketplace $REPO"
done
