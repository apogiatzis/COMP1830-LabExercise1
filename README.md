## Lab Exercise 1 for COMP 1830

Please go to moodle to download the corresponding lab sheet.

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/apogiatzis/COMP1830-LabExercise1)

### Running in GitHub Codespaces

1. Click the **Open in GitHub Codespaces** button above and sign in with your GitHub account.
2. Wait for the codespace to build. The dependencies in `requirements.txt` are installed automatically.
3. To run several peers (Exercises 2.4 and 2.5), open extra terminals with the **+** button in the terminal panel, one per peer, plus one for the Lab Visualiser (see below).

When you finish the lab, stop your codespace so it doesn't use up your free monthly hours: open the Command Palette (Ctrl/Cmd+Shift+P) and run **Codespaces: Stop Current Codespace**.

### Lab Visualiser

The visualiser shows the peers' blockchains and the messages between them in the browser. With your peers running, open another terminal and run:

```
cd dissecting-blockchain
python visualiser.py
```

In Codespaces it opens in a new browser tab (or find **Lab Visualiser** in the **Ports** panel). Locally, open http://localhost:8000.

It finds peers on ports 8001-8010, started with either `peer.py` or `pow_peer.py`. Every button runs one of the peer's shell commands, and the command is echoed in that peer's terminal.

### Running locally

Requires Python 3.12 (the version used in Codespaces).

```
pip install -r requirements.txt
```
