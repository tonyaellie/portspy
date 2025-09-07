# PortSpy

`portspy` is a powerful and interactive command-line interface (CLI) tool built with [Bun](https://bun.sh/) and [React Ink](https://www.npmjs.com/package/ink). It allows you to quickly see which processes are using which network ports on your system, filter the results, and even kill rogue processes, with optional sudo escalation.

Designed for developers, system administrators, and anyone who needs quick insights into their network activity.

## Installation

`portspy` requires [Bun](https://bun.sh/) to be installed on your system.

### Via Bun (Recommended)

To install `portspy` globally using Bun:

```bash
bun install -g portspy
```

After installation, you can run `portspy` from anywhere:

```bash
portspy
```

### Manual Installation (for development or specific environments)

1.  Clone the repository:
    ```bash
    git clone https://github.com/tonyaellie/portspy.git
    cd portspy
    ```
2.  Install dependencies:
    ```bash
    bun install
    ```
3.  Make the CLI executable (if running directly from source):
    ```bash
    chmod +x cli.tsx
    ```
4.  Run `portspy` (requires `bun` command to be in your PATH):
    ```bash
    bun ./cli.tsx
    ```

## Usage

When `portspy` launches, you'll see a list of network connections and listening ports.

### Keybindings

- **Up/Down Arrows:** Navigate through the list of processes.
- **`/` (Slash):** Enter search mode. Start typing digits to filter by port number.
- **`Enter` (in search mode):** Exit search mode.
- **`c`:** Clear the current search filter.
- **`Enter` or `k`:** Send `SIGTERM` (graceful termination) to the selected process.
- **`K`:** Send `SIGKILL` (forceful termination, `kill -9`) to the selected process.
- **`y` / `n` (during kill confirmation):** Confirm or cancel the kill action. `Y` for forceful kill during confirmation.
- **`r`:** Refresh the list of ports and processes.
- **`?` or `h`:** Toggle the help overlay for keybindings and tips.
- **`q`:** Quit `portspy`.
- **`Esc`:** Exit search mode or cancel a confirmation prompt.

### Sudo Escalation

If you attempt to kill a process for which you don't have permissions, `portspy` will automatically detect this and prompt you to retry the kill action with `sudo`. When `sudo` is invoked, `portspy` temporarily releases control of the terminal to allow for password input, then resumes gracefully.

### For Best Results

`portspy` prefers to use `lsof` for more detailed process information. If you're on a Debian-based system (like Ubuntu) and `lsof` isn't installed, you might see a tip in the CLI:

```bash
sudo apt install lsof
```

## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details.
