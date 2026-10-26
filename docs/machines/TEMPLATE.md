# <Machine family name>

<One or two sentences: what the machine was, and what zx84 emulates of it.>

| | |
| --- | --- |
| **Manufacturer** | <Company (and designer / licensees, if relevant)> |
| **Released** | <Year range across the models below> |
| **CPU** | <CPU and clock(s)> |
| **zx84 kind** | `<machine kind>` — [`src/machines/<name>/`](../../src/machines/<name>/) |
| **Model ids** | `<id>` `<id>` … — exactly the registry ids: the MCP `model` target and the `?model=` value |
| **Accuracy** | <cycle / scanline / frame, from `descriptor.ui.accuracy`> |
| **Status** | <one line: e.g. "Mature — passes the reference timing tests"> |

**Legend:** ✅ supported · ◐ partial (see notes) · ✗ not emulated · — not applicable to this model

---

## Models

| Model | Year | RAM | ROM | Video | Sound | Storage | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| <Model> (`id`) | | | | | | | |

### ROM sets

| Model | Locale | ROM pages | Source |
| --- | --- | --- | --- |
| | | | hosted / user-supplied |

---

## Built-in hardware

What every model (or a subset) has on the motherboard. One row per chip or
custom part; say where it lives in the code.

| Part | Models | Status | Notes |
| --- | --- | --- | --- |
| <CPU> | all | ✅ | |
| <Video chip> | | | |
| <Sound chip> | | | |
| <Keyboard> | | | |
| <Cassette interface> | | | |
| <Disk controller> | | | |

---

## Peripherals

Add-ons the user can fit (Hardware pane) or that are always attached.

| Peripheral | Type | Models | Status | Notes |
| --- | --- | --- | --- | --- |
| <Name> | disk / input / ROM / comms / sound | | | |

**Combination rules:** <which peripherals are mutually exclusive, precedence>

---

## Media formats

| Extension | Kind | Device | Load | Save | Notes |
| --- | --- | --- | --- | --- | --- |
| `.ext` | snapshot / tape / disk / cartridge / program | <where it mounts> | ✅ | ✅ / ✗ | |

**Save menu exports:** <screenshot, screen dump, RAM dump …>

---

## Emulation features

Accuracy and convenience features specific to this machine.

| Feature | Status | Notes |
| --- | --- | --- |
| <Timing / contention> | | |
| <Fast / turbo loading> | | |
| <Display effects> | | |

---

## Tools and integration

| Tool | Status | Notes |
| --- | --- | --- |
| Debugger (breakpoints, stepping, disassembly) | | |
| Trace | | |
| Screen OCR / TEXT overlay | | |
| Software library | | |
| Machine-specific panes | | |
| MCP tools | | <generic + machine-specific tool names> |

---

## Known issues

Real bugs or gaps: things that behave differently from the real machine.

| Issue | Affects | Severity | Notes |
| --- | --- | --- | --- |
| | | high / medium / low | <repro, suspected cause, tracking link> |

## Not emulated

Hardware deliberately left out (or stubbed) — not bugs, just scope.

- <Part> — <why / what happens if software uses it>

## Faithful quirks

Behaviour that looks like a bug but matches real hardware. List these so they
don't get "fixed".

- <Title> — <what happens and why that's correct>

---

## Verification

| Reference | Result | Last checked |
| --- | --- | --- |
| <test suite / tape / disk set> | | YYYY-MM-DD |
