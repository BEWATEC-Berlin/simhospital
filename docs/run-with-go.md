# Running Simhospital with the Go Toolchain (No Bazel)

The original setup uses Bazel as its build system. This guide explains how to
build and run Simhospital using the standard Go toolchain instead. This is
necessary because the project's Bazel configuration is outdated and incompatible
with both current Bazel versions (7+) and Apple Silicon (arm64) Macs.

## Prerequisites

- [Go](https://go.dev/dl/) 1.22 or later
- Git

Verify your Go installation:

```shell
go version
```

## Steps

### 1. Clone the repository

```shell
git clone https://github.com/BEWATEC-Berlin/simhospital.git
cd simhospital
```

### 2. Download dependencies

```shell
go mod download
```

This downloads all dependencies listed in `go.mod`. It will take a moment on
first run.

### 3. Build the binary

```shell
go build ./cmd/simulator/
```

This compiles the simulator and writes the binary to `simulator` in the project root.

### 4. Run the simulator

```shell
./simulator --local_path=$(pwd)
```

`--local_path` must point to the root of the repository so the simulator can
find the config files in the `configs/` folder.

The simulator will start printing HL7v2 messages to the console. Stop it with
**Ctrl-C**.

## Dashboard

Once running, open the dashboard at http://localhost:8000/simulated-hospital/ in your browser.
The dashboard can be used to configure the amount of random pathways started per hour.
It is also possible to directly send messages or run a specific pathway from the dashboard.

---

## Sending messages over MLLP

By default the simulator prints HL7v2 messages to stdout. To send them over
[MLLP](https://www.hl7.org/implement/standards/product_brief.cfm?product_id=55)
to a receiver (e.g. a Medplum agent), use the `--output=mllp` and
`--mllp_destination` flags.

MLLP is a raw TCP protocol — the simulator opens a direct connection to the
destination on startup. There is no buffering, so the receiver must be reachable
when the simulator connects. The three approaches below cover the common
scenarios.

### Option 1 — Start the receiver first (recommended)

Start your MLLP receiver (e.g. the Medplum agent) so it is already listening on
the target port, then start the simulator:

```shell
./simulator --local_path=$(pwd) \
  --output=mllp \
  --mllp_destination=localhost:56000
```

The simulator connects immediately and starts sending.

### Option 2 — Auto-reconnect with keep-alive

If you want to start the simulator before the receiver is ready, use
`--mllp_keep_alive`. The simulator will retry the connection at the given
interval and connect automatically once the receiver comes up:

```shell
./simulator --local_path=$(pwd) \
  --output=mllp \
  --mllp_destination=localhost:56000 \
  --mllp_keep_alive=true \
  --mllp_keep_alive_interval=10s
```

### Option 3 — Buffer to a file first

Write messages to a file while the receiver is not yet ready. Replay or
forward the file contents once the receiver is up:

```shell
./simulator --local_path=$(pwd) \
  --output=file \
  --output_file=$(pwd)/hl7_messages.out
```

---

## Optional: build into a `bin/` directory

If you prefer to keep the project root clean, you can output the binary to a
subdirectory instead:

```shell
go build -o bin/simulator ./cmd/simulator/
./bin/simulator --local_path=$(pwd)
```

To keep both the binary and the directory out of Git, add this to `.gitignore`:

```
bin/
simulator
```

If you build to the root (no `-o` flag), only `simulator` needs to be ignored.

---

## Why not Bazel?

The project's `WORKSPACE` file targets `rules_go v0.24.11` (released 2020),
which predates Apple Silicon and is incompatible with Bazel 7+. The
`MODULE.bazel` file (required by Bazel 7+ Bzlmod) is empty. As a result,
`bazel build //...` fails with dependency resolution errors on any modern
setup.

The Go toolchain approach bypasses these issues entirely — the source code
itself is valid Go and builds cleanly with the standard toolchain.
