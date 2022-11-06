# xen-midi
Free-pitch polyphonic MIDI I/O based on webmidi.js using multi-channel pitch-bend

## Installation ##
```bash
npm i
```

## Documentation ##
Documentation is hosted at the project [Github pages](https://xenharmonic-devs.github.io/xen-midi).

To generate documentation locally run:
```bash
npm run doc
```

## Example

```typescript
import {WebMidi} from 'webmidi';
import {MidiOut} from 'xen-midi';

async function play() {
  await WebMidi.enable();

  // Set maximum microtonal polyphony to 4 (the number of channels reserved).
  const channels = new Set([1, 2, 3, 4]);
  const midiOut = new MidiOut(WebMidi.outputs[1], channels);

  // Play a just intonation 4:5:6 major chord.
  midiOut.playNotes([
    {
      frequency: 440,  // Frequency in Hz
      rawAttack: 80,   // Attack velocity from 0 to 127
      rawRelease: 80,  // Release velocity from 0 to 127
      time: "+0",      // Relative time starting from now
      duration: 500,   // Time is measured in ms
    },
    // Attack and release default to 64.
    {
      frequency: 550,
      time: "+100",
      duration: 500,
    },
    {
      frequency: 660,
      time: "+200",
      duration: 500,
    }
  ]);
}

play();
```
