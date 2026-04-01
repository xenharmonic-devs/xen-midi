# xen-midi

Free-pitch polyphonic MIDI I/O based on webmidi.js using multi-channel pitch-bend.

## Installation

Install the package from npm:

```bash
npm install xen-midi
```

## Documentation

API docs are generated with TypeDoc from the source comments in `src/index.ts` and published at the project GitHub Pages site:

- https://xenharmonic-devs.github.io/xen-midi

To regenerate TypeDoc locally:

```bash
npm run doc
```

This command writes documentation output to `docs/`.

## Example

```ts
import {WebMidi} from 'webmidi';
import {MidiOut} from 'xen-midi';

async function play() {
  await WebMidi.enable();

  // Set maximum microtonal polyphony to 4 (the number of channels reserved).
  const channels = new Set([1, 2, 3, 4]);
  const midiOut = new MidiOut(WebMidi.outputs[0], channels);

  // Play a just intonation 4:5:6 major chord.
  midiOut.playNotes([
    {
      frequency: 440,
      rawAttack: 80,
      rawRelease: 80,
      time: '+0',
      duration: 500,
    },
    // Attack and release default to 64.
    {
      frequency: 550,
      time: '+100',
      duration: 500,
    },
    {
      frequency: 660,
      time: '+200',
      duration: 500,
    },
  ]);
}

play();
```

### Note fields used in `playNotes`

- `frequency`: frequency in Hertz (Hz)
- `rawAttack`: attack velocity from `0` to `127` (optional, defaults to `64`)
- `rawRelease`: release velocity from `0` to `127` (optional, defaults to `64`)
- `time`: note-on time in milliseconds; use `'+N'` for a delay of `N` ms from now
- `duration`: note length in milliseconds (ms)

## API overview

The library exports:

- `BEND_RANGE_IN_SEMITONES`
- `MidiOut`
- `MidiIn`
- `midiKeyInfo`
- Type aliases: `Voice`, `Note`, `NoteOff`, `NoteOnCallback`, `MidiKeyInfo`
