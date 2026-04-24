import {describe, it, expect, vi, Mock} from 'vitest';
import {MidiIn, MidiOut} from '../index.js';
import {Input, Output} from 'webmidi';

const MAX_VELOCITY = 127;

class MockMIDIOutput {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  send(data: number[] | Uint8Array, timestamp?: number) {}
}

describe('Microtonal MIDI output', () => {
  it('Re-uses channels that have the correct pitch bend already', () => {
    const mockOutput = new MockMIDIOutput();
    const sendSpy = vi.spyOn(mockOutput, 'send');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = new Output(mockOutput as any);
    const channels = new Set([1, 2]);
    const log = vi.fn();
    const out = new MidiOut(output, channels, {log});

    expect(sendSpy).toBeCalledTimes(12);

    const off440 = out.sendNoteOn(440, MAX_VELOCITY);
    expect(sendSpy).toBeCalledTimes(14);
    expect(log).toHaveBeenCalledWith(
      'Sending note on 69 at velocity 1 on channel 1 with bend 0 resulting from frequency 440',
    );

    off440(MAX_VELOCITY);
    expect(sendSpy).toBeCalledTimes(15);
    expect(log).toHaveBeenCalledWith(
      'Sending note off 69 at velocity 1 on channel 1',
    );

    const off550 = out.sendNoteOn(550, MAX_VELOCITY);
    expect(sendSpy).toBeCalledTimes(17);
    expect(log).toHaveBeenCalledWith(
      'Sending note on 73 at velocity 1 on channel 2 with bend -13.686286135165915 resulting from frequency 550',
    );

    const off1100 = out.sendNoteOn(1100, MAX_VELOCITY);
    expect(sendSpy).toBeCalledTimes(19);
    expect(log).toBeCalledWith('Re-using channel 2');

    off550(MAX_VELOCITY);
    expect(sendSpy).toBeCalledTimes(20);
    off1100(MAX_VELOCITY);
    expect(sendSpy).toBeCalledTimes(21);
  });

  it('logs zero velocity correctly instead of falling back to default', () => {
    const mockOutput = new MockMIDIOutput();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = new Output(mockOutput as any);
    const log = vi.fn();
    const out = new MidiOut(output, new Set([1]), {log});

    const off = out.sendNoteOn(440, 0);
    expect(log).toHaveBeenCalledWith(
      'Sending note on 69 at velocity 0 on channel 1 with bend 0 resulting from frequency 440',
    );

    off(0);
    expect(log).toHaveBeenCalledWith(
      'Sending note off 69 at velocity 0 on channel 1',
    );
  });
});

class MockSynth {
  offs: Mock[];
  constructor() {
    this.offs = [];
  }
  // Only two parameters here to make sure that TypeScript still accepts the callback.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  noteOn(index: number, rawAttack: number) {
    const off = vi.fn();
    this.offs.push(off);
    return off;
  }
}

class MockOctaveSynth {
  frequenciesPlayed: number[];
  constructor() {
    this.frequenciesPlayed = [];
  }
  noteOn(index: number, rawAttack: number, channel: number) {
    const frequency = 440 * 2 ** ((index - 69) / 31 + channel - 3);
    this.frequenciesPlayed.push(frequency);
    return () => undefined;
  }
}
describe('MIDI input wrapper', () => {
  it('triggers note offs from different channel at the same index', () => {
    const synth = new MockSynth();
    const spy = vi.spyOn(synth, 'noteOn');
    const midiIn = new MidiIn(synth.noteOn.bind(synth), new Set([1, 2]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockInput: any = {};
    const input = new Input(mockInput);
    midiIn.listen(input);

    // Synthesize note on message on channel 1
    mockInput.onmidimessage({data: [144, 69, 127]});
    expect(spy).toHaveBeenCalledWith(69, 127, 1);
    expect(synth.offs).toHaveLength(1);
    expect(synth.offs[0]).not.toBeCalled();

    // Note on message on channel 2
    mockInput.onmidimessage({data: [145, 69, 127]});
    expect(synth.offs).toHaveLength(2);
    expect(synth.offs[0]).not.toBeCalled();
    expect(synth.offs[1]).not.toBeCalled();

    // Note off message on channel 2
    mockInput.onmidimessage({data: [129, 69, 127]});
    expect(synth.offs[1]).toBeCalledWith(127);

    // Note off message on channel 1
    mockInput.onmidimessage({data: [128, 69, 127]});
    expect(synth.offs[0]).toBeCalledWith(127);
  });

  it('re-triggers an already active key by releasing the previous voice first', () => {
    const synth = new MockSynth();
    const midiIn = new MidiIn(synth.noteOn.bind(synth), new Set([1]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockInput: any = {};
    const input = new Input(mockInput);
    midiIn.listen(input);

    // First note-on on channel 1
    mockInput.onmidimessage({data: [144, 69, 100]});
    expect(synth.offs).toHaveLength(1);
    expect(synth.offs[0]).not.toBeCalled();

    // Re-trigger before note-off should release the previous callback.
    mockInput.onmidimessage({data: [144, 69, 70]});
    expect(synth.offs).toHaveLength(2);
    expect(synth.offs[0]).toBeCalledWith();
    expect(synth.offs[1]).not.toBeCalled();

    // Final note-off should only target the latest callback.
    mockInput.onmidimessage({data: [128, 69, 60]});
    expect(synth.offs[1]).toBeCalledWith(60);
  });

  it('treats note-on with zero velocity as note-off', () => {
    const synth = new MockSynth();
    const midiIn = new MidiIn(synth.noteOn.bind(synth), new Set([1]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockInput: any = {};
    const input = new Input(mockInput);
    midiIn.listen(input);

    mockInput.onmidimessage({data: [144, 69, 100]});
    expect(synth.offs).toHaveLength(1);

    // Some devices send note-on with velocity 0 instead of note-off.
    mockInput.onmidimessage({data: [144, 69, 0]});
    expect(synth.offs[0]).toBeCalledWith(0);
    expect(synth.offs).toHaveLength(1);
  });

  it('provides the channel number for e.g. octave shifting', () => {
    const synth = new MockOctaveSynth();
    const midiIn = new MidiIn(
      synth.noteOn.bind(synth),
      new Set([1, 2, 3, 4, 5, 6]),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockInput: any = {};
    const input = new Input(mockInput);
    midiIn.listen(input);

    // Note on message on channel 3
    mockInput.onmidimessage({data: [146, 69, 127]});
    // Note on message on channel 2
    mockInput.onmidimessage({data: [145, 69, 127]});

    expect(synth.frequenciesPlayed).toEqual([440, 220]);
  });

  it('delays note-off callbacks while hold pedal is pressed when enabled', () => {
    const synth = new MockSynth();
    const midiIn = new MidiIn(synth.noteOn.bind(synth), new Set([1]), {
      sustainPedal: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockInput: any = {};
    const input = new Input(mockInput);
    midiIn.listen(input);

    mockInput.onmidimessage({data: [144, 69, 100]}); // note-on channel 1
    expect(synth.offs).toHaveLength(1);

    mockInput.onmidimessage({data: [176, 64, 127]}); // hold pedal down
    mockInput.onmidimessage({data: [128, 69, 45]}); // note-off channel 1
    expect(synth.offs[0]).not.toBeCalled();

    mockInput.onmidimessage({data: [176, 64, 0]}); // hold pedal up
    expect(synth.offs[0]).toBeCalledWith(45);
  });

  it('releases old held voice before re-triggering the same key', () => {
    const synth = new MockSynth();
    const midiIn = new MidiIn(synth.noteOn.bind(synth), new Set([1]), {
      sustainPedal: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockInput: any = {};
    const input = new Input(mockInput);
    midiIn.listen(input);

    mockInput.onmidimessage({data: [144, 69, 100]}); // first note-on
    mockInput.onmidimessage({data: [176, 64, 127]}); // hold pedal down
    mockInput.onmidimessage({data: [128, 69, 45]}); // deferred note-off
    expect(synth.offs[0]).not.toBeCalled();

    mockInput.onmidimessage({data: [144, 69, 80]}); // re-trigger same key
    expect(synth.offs).toHaveLength(2);
    expect(synth.offs[0]).toBeCalledWith(45);
    expect(synth.offs[1]).not.toBeCalled();

    mockInput.onmidimessage({data: [176, 64, 0]}); // hold pedal up should not kill new note
    expect(synth.offs[1]).not.toBeCalled();
  });

  it('applies sostenuto only to notes held when pedal is pressed', () => {
    const synth = new MockSynth();
    const midiIn = new MidiIn(synth.noteOn.bind(synth), new Set([1]), {
      sustainPedal: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockInput: any = {};
    const input = new Input(mockInput);
    midiIn.listen(input);

    mockInput.onmidimessage({data: [144, 69, 100]}); // held before sostenuto
    mockInput.onmidimessage({data: [176, 66, 127]}); // sostenuto down
    mockInput.onmidimessage({data: [128, 69, 55]}); // deferred by sostenuto
    expect(synth.offs[0]).not.toBeCalled();

    mockInput.onmidimessage({data: [144, 70, 100]}); // pressed after sostenuto
    mockInput.onmidimessage({data: [128, 70, 60]}); // should release immediately
    expect(synth.offs[1]).toBeCalledWith(60);

    mockInput.onmidimessage({data: [176, 66, 0]}); // sostenuto up releases held note
    expect(synth.offs[0]).toBeCalledWith(55);
  });

  it('keeps hold and sostenuto deferred notes independent', () => {
    const synth = new MockSynth();
    const midiIn = new MidiIn(synth.noteOn.bind(synth), new Set([1]), {
      sustainPedal: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockInput: any = {};
    const input = new Input(mockInput);
    midiIn.listen(input);

    mockInput.onmidimessage({data: [144, 69, 100]}); // note to be captured by sostenuto
    mockInput.onmidimessage({data: [176, 66, 127]}); // sostenuto down
    mockInput.onmidimessage({data: [176, 64, 127]}); // hold pedal down

    mockInput.onmidimessage({data: [128, 69, 50]}); // deferred by both pedals
    expect(synth.offs[0]).not.toBeCalled();

    mockInput.onmidimessage({data: [144, 70, 100]}); // note after sostenuto
    mockInput.onmidimessage({data: [128, 70, 60]}); // deferred only by hold pedal
    expect(synth.offs[1]).not.toBeCalled();

    mockInput.onmidimessage({data: [176, 64, 0]}); // hold pedal up
    expect(synth.offs[1]).toBeCalledWith(60); // released from hold-only defer
    expect(synth.offs[0]).not.toBeCalled(); // still deferred by sostenuto

    mockInput.onmidimessage({data: [176, 66, 0]}); // sostenuto up
    expect(synth.offs[0]).toBeCalledWith(50);
  });

  it('maintains sostenuto when captured keys are re-pressed', () => {
    const synth = new MockSynth();
    const midiIn = new MidiIn(synth.noteOn.bind(synth), new Set([1]), {
      sustainPedal: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockInput: any = {};
    const input = new Input(mockInput);
    midiIn.listen(input);

    mockInput.onmidimessage({data: [144, 69, 100]}); // note to be captured by sostenuto
    mockInput.onmidimessage({data: [176, 66, 127]}); // sostenuto down

    mockInput.onmidimessage({data: [128, 69, 50]}); // note up deferred
    expect(synth.offs[0]).not.toBeCalled();

    mockInput.onmidimessage({data: [144, 69, 120]}); // note on causing re-trigger while maintaining capture
    expect(synth.offs[0]).toBeCalledWith(50);

    mockInput.onmidimessage({data: [128, 69, 60]}); // note up still deferred
    expect(synth.offs[1]).not.toBeCalled();

    mockInput.onmidimessage({data: [144, 69, 130]}); // note on causing re-trigger while maintaining capture
    expect(synth.offs[1]).toBeCalledWith(60);

    mockInput.onmidimessage({data: [128, 69, 70]}); // note up still deferred
    expect(synth.offs[2]).not.toBeCalled();

    mockInput.onmidimessage({data: [176, 66, 0]}); // sostenuto up
    expect(synth.offs[2]).toBeCalledWith(70);
  });
});
