import type {NoteMessageEvent, Output, Input} from 'webmidi';
import {ftom} from 'xen-dev-utils';

/**
 * Pitch bend range measured in semitones (+-).
 */
export const BEND_RANGE_IN_SEMITONES = 2;

// Large but finite number to signify voices that are off
const EXPIRED = 10000;

// Cents offset tolerance for channel reuse.
const EPSILON = 1e-6;

/**
 * Abstraction for a pitch-bent midi channel.
 * Polyphonic in pure octaves and 12edo in general.
 */
type Voice = {
  age: number;
  channel: number;
  centsOffset: number;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function emptyNoteOff(rawRelease: number) {}

/**
 * Returned by MIDI note on. Turns the note off when called.
 */
export type NoteOff = typeof emptyNoteOff;

/**
 * Wrapper for a webmidi.js output.
 * Uses multiple channels to achieve polyphonic microtuning.
 */
export class MidiOut {
  output: Output | null;
  channels: Set<number>;
  log: (msg: string) => void;
  private voices: Voice[];

  /**
   * Constuct a new wrapper for a webmidi.js output.
   * @param output Output device or `null` if you need a dummy out.
   * @param channels Channels to use for sending pitch bent MIDI notes. Number of channels determines maximum microtonal polyphony.
   * @param log Logging function.
   */
  constructor(
    output: Output | null,
    channels: Set<number>,
    log?: (msg: string) => void
  ) {
    this.output = output;
    this.channels = channels;
    if (log === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      this.log = msg => {};
    } else {
      this.log = log;
    }

    this.voices = [];
    this.channels.forEach(channel => {
      this.voices.push({
        age: EXPIRED,
        centsOffset: NaN,
        channel,
      });
    });

    this.sendPitchBendRange();
  }

  private sendPitchBendRange() {
    if (this.output !== null) {
      this.channels.forEach(channel => {
        this.output!.channels[channel].sendPitchBendRange(
          BEND_RANGE_IN_SEMITONES,
          0
        );
      });
    }
  }

  /**
   * Select a voice that's using a cents offset combatible channel or the oldest voice if nothing can be re-used.
   * @param centsOffset Cents offset (pitch-bend) from 12edo.
   * @returns A voice for the next note-on event.
   */
  private selectVoice(centsOffset: number) {
    // Age signifies how many note ons have occured after voice intialization
    this.voices.forEach(voice => voice.age++);

    // Re-use a channel that already has the correct pitch bend
    for (let i = 0; i < this.voices.length; ++i) {
      if (Math.abs(this.voices[i].centsOffset - centsOffset) < EPSILON) {
        this.log(`Re-using channel ${this.voices[i].channel}`);
        this.voices[i].age = 0;
        return this.voices[i];
      }
    }

    // Nothing re-usable found. Use the oldest voice.
    let oldestVoice = this.voices[0];
    this.voices.forEach(voice => {
      if (voice.age > oldestVoice.age) {
        oldestVoice = voice;
      }
    });
    oldestVoice.age = 0;
    oldestVoice.centsOffset = centsOffset;
    return oldestVoice;
  }

  /**
   * Send a note-on event and pitch-bend to the output device in one of the available channels.
   * @param frequency Frequency of the note in Hertz (Hz).
   * @param rawAttack Attack velocity of the note in from 0 to 127.
   * @returns A callback for sending a corresponding note off in the correct channel.
   */
  sendNoteOn(frequency: number, rawAttack: number): NoteOff {
    if (this.output === null) {
      return emptyNoteOff;
    }
    if (!this.channels.size) {
      return emptyNoteOff;
    }
    const [noteNumber, centsOffset] = ftom(frequency);
    if (noteNumber < 0 || noteNumber >= 128) {
      return emptyNoteOff;
    }
    const voice = this.selectVoice(centsOffset);
    this.log(
      `Sending note on ${noteNumber} at velocity ${
        rawAttack / 127
      } on channel ${
        voice.channel
      } with bend ${centsOffset} resulting from frequency ${frequency}`
    );
    const bendRange = BEND_RANGE_IN_SEMITONES * 100;
    this.output.channels[voice.channel].sendPitchBend(centsOffset / bendRange);
    this.output.channels[voice.channel].sendNoteOn(noteNumber, {rawAttack});

    const noteOff = (rawRelease: number) => {
      this.log(
        `Sending note off ${noteNumber} at velocity ${
          rawRelease / 127
        } on channel ${voice.channel}`
      );
      voice.age = EXPIRED;
      this.output!.channels[voice.channel].sendNoteOff(noteNumber, {
        rawRelease,
      });
    };
    return noteOff;
  }
}

/**
 * Function to call when a MIDI note-on event is received (e.g. for turning on your synth).
 * Attack velocity is from 0 to 127.
 * Must return a note-off callback (e.g. for turning off your synth).
 */
export type NoteOnCallback = (index: number, rawAttack: number) => NoteOff;

/**
 * Wrapper for webmidi.js input.
 * Listens on multiple channels.
 */
export class MidiIn {
  callback: NoteOnCallback;
  channels: Set<number>;
  private noteOffMap: Map<number, (rawRelease: number) => void>;
  private _noteOn: (event: NoteMessageEvent) => void;
  private _noteOff: (event: NoteMessageEvent) => void;
  log: (msg: string) => void;

  /**
   * Construct a new wrapper for a webmidi.js input device.
   * @param callback Function to call when a note-on event is received on any of the available channels.
   * @param channels Channels to listen on.
   * @param log Logging function.
   */
  constructor(
    callback: NoteOnCallback,
    channels: Set<number>,
    log?: (msg: string) => void
  ) {
    this.callback = callback;
    this.channels = channels;
    this.noteOffMap = new Map();

    this._noteOn = this.noteOn.bind(this);
    this._noteOff = this.noteOff.bind(this);

    if (log === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      this.log = msg => {};
    } else {
      this.log = log;
    }
  }

  /**
   * Make this wrapper (and your callback) respond to note-on/off events from this MIDI input.
   * @param input MIDI input to listen to.
   */
  listen(input: Input) {
    input.addListener('noteon', this._noteOn);
    input.addListener('noteoff', this._noteOff);
  }

  /**
   * Make this wrapper (and your callback) stop responding to note-on/off events from this MIDI input.
   * @param input MIDI input that was listened to.
   */
  unlisten(input: Input) {
    input.removeListener('noteon', this._noteOn);
    input.removeListener('noteoff', this._noteOff);
  }

  private noteOn(event: NoteMessageEvent) {
    if (!this.channels.has(event.message.channel)) {
      return;
    }
    const noteNumber = event.note.number;
    const attack = event.note.attack;
    const rawAttack = event.note.rawAttack;
    this.log(`Midi note on ${noteNumber} at velocity ${attack}`);
    const noteOff = this.callback(noteNumber, rawAttack);
    this.noteOffMap.set(noteNumber, noteOff);
  }

  private noteOff(event: NoteMessageEvent) {
    if (!this.channels.has(event.message.channel)) {
      return;
    }
    const noteNumber = event.note.number;
    const release = event.note.release;
    const rawRelease = event.note.rawRelease;
    this.log(`Midi note off ${noteNumber} at velocity ${release}`);
    const noteOff = this.noteOffMap.get(noteNumber);
    if (noteOff !== undefined) {
      this.noteOffMap.delete(noteNumber);
      noteOff(rawRelease);
    }
  }

  /**
   * Fire global note-off.
   */
  deactivate() {
    for (const [noteNumber, noteOff] of this.noteOffMap) {
      this.noteOffMap.delete(noteNumber);
      noteOff(80);
    }
  }
}

/**
 * Information about a MIDI key.
 */
export type MidiKeyInfo =
  | {
      /** Contiguous index of the key with other white keys. */
      whiteNumber: number;
      sharpOf?: undefined;
      flatOf?: undefined;
    }
  | {
      whiteNumber?: undefined;
      /** This black key is a sharp of that white key. */
      sharpOf: number;
      /** This black key is a flat of that white key. */
      flatOf: number;
    };

const WHITES = [0, 2, 4, 5, 7, 9, 11];

/**
 * Get information about a MIDI key.
 * @param chromaticNumber Contiguous chromatic index of the MIDI key
 * @returns Information about the MIDI key.
 */
export function midiKeyInfo(chromaticNumber: number): MidiKeyInfo {
  const octave = Math.floor(chromaticNumber / 12);
  const index = chromaticNumber - 12 * octave;
  if (WHITES.includes(index)) {
    return {
      whiteNumber: Math.floor((index + 1) / 2) + 7 * octave,
    };
  }
  if (index === 1 || index === 3) {
    return {
      sharpOf: (index - 1) / 2 + 7 * octave,
      flatOf: (index + 1) / 2 + 7 * octave,
    };
  }
  return {
    sharpOf: index / 2 + 7 * octave,
    flatOf: (index + 2) / 2 + 7 * octave,
  };
}
