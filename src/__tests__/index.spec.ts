import {describe, it, expect, vi, Mock} from 'vitest';
import {MidiIn, MidiOut} from '..';
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
    const out = new MidiOut(output, channels, log);

    expect(sendSpy).toBeCalledTimes(12);

    const off440 = out.sendNoteOn(440, MAX_VELOCITY);
    expect(sendSpy).toBeCalledTimes(14);
    expect(log).toHaveBeenCalledWith(
      'Sending note on 69 at velocity 1 on channel 1 with bend 0 resulting from frequency 440'
    );

    off440(MAX_VELOCITY);
    expect(sendSpy).toBeCalledTimes(15);
    expect(log).toHaveBeenCalledWith(
      'Sending note off 69 at velocity 1 on channel 1'
    );

    const off550 = out.sendNoteOn(550, MAX_VELOCITY);
    expect(sendSpy).toBeCalledTimes(17);
    expect(log).toHaveBeenCalledWith(
      'Sending note on 73 at velocity 1 on channel 2 with bend -13.686286135165915 resulting from frequency 550'
    );

    const off1100 = out.sendNoteOn(1100, MAX_VELOCITY);
    expect(sendSpy).toBeCalledTimes(19);
    expect(log).toBeCalledWith('Re-using channel 2');

    off550(MAX_VELOCITY);
    expect(sendSpy).toBeCalledTimes(20);
    off1100(MAX_VELOCITY);
    expect(sendSpy).toBeCalledTimes(21);
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

  it('provides the channel number for e.g. octave shifting', () => {
    const synth = new MockOctaveSynth();
    const midiIn = new MidiIn(
      synth.noteOn.bind(synth),
      new Set([1, 2, 3, 4, 5, 6])
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
});
