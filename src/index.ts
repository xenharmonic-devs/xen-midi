import {NoteMessageEvent, Output, Input, WebMidi} from 'webmidi';
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
export type Voice = {
  age: number;
  channel: number;
  centsOffset: number;
};

/**
 * Free-pitch MIDI note to be played at a later time.
 */
export type Note = {
  /** Frequency in Hertz (Hz) */
  frequency: number;
  /** Attack velocity from 0 to 127. */
  rawAttack?: number;
  /** Release velocity from 0 to 127. */
  rawRelease?: number;
  /** Note-on time in milliseconds (ms) as measured by `WebMidi.time`.
   * If time is a string prefixed with "+" and followed by a number, the message will be delayed by that many milliseconds.
   */
  time: DOMHighResTimeStamp | string;
  /** Note duration in milliseconds (ms). */
  duration: DOMHighResTimeStamp;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function emptyNoteOff(rawRelease?: number, time?: DOMHighResTimeStamp) {}

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
  private lastEventTime: DOMHighResTimeStamp;

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
    this.lastEventTime = WebMidi.time;

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
   * @param rawAttack Attack velocity of the note from 0 to 127.
   * @returns A callback for sending a corresponding note off in the correct channel.
   */
  sendNoteOn(
    frequency: number,
    rawAttack?: number,
    time?: DOMHighResTimeStamp
  ): NoteOff {
    if (time === undefined) {
      time = WebMidi.time;
    }
    if (time < this.lastEventTime) {
      throw new Error(
        `Events must be triggered in causal order: ${time} < ${this.lastEventTime} (note on)`
      );
    }
    this.lastEventTime = time;

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
        (rawAttack || 64) / 127
      } on channel ${
        voice.channel
      } with bend ${centsOffset} resulting from frequency ${frequency}`
    );
    const bendRange = BEND_RANGE_IN_SEMITONES * 100;
    this.output.channels[voice.channel].sendPitchBend(centsOffset / bendRange);
    this.output.channels[voice.channel].sendNoteOn(noteNumber, {
      rawAttack,
      time,
    });

    const noteOff = (rawRelease?: number, time?: DOMHighResTimeStamp) => {
      if (time === undefined) {
        time = WebMidi.time;
      }
      if (time < this.lastEventTime) {
        throw new Error(
          `Events must be triggered in causal order: ${time} < ${this.lastEventTime} (note off)`
        );
      }
      this.lastEventTime = time;

      this.log(
        `Sending note off ${noteNumber} at velocity ${
          (rawRelease || 64) / 127
        } on channel ${voice.channel}`
      );
      voice.age = EXPIRED;
      this.output!.channels[voice.channel].sendNoteOff(noteNumber, {
        rawRelease,
        time,
      });
    };
    return noteOff;
  }

  /**
   * Schedule a series of notes to be played at a later time.
   * Please note that this reserves the channels until all notes have finished playing.
   * @param notes Notes to be played.
   */
  playNotes(notes: Note[]) {
    // Break notes into events.
    const now = WebMidi.time;
    const events = [];
    for (const note of notes) {
      let time: number;
      if (typeof note.time === 'string') {
        if (note.time.startsWith('+')) {
          time = now + parseFloat(note.time.slice(1));
        } else {
          time = parseFloat(note.time);
        }
      } else {
        time = note.time;
      }
      const off = {
        type: 'off' as const,
        rawRelease: note.rawRelease,
        time: time + note.duration,
        callback: emptyNoteOff,
      };
      events.push({
        type: 'on' as const,
        frequency: note.frequency,
        rawAttack: note.rawAttack,
        time,
        off,
      });
      events.push(off);
    }

    // Sort events in causal order.
    events.sort((a, b) => a.time - b.time);

    // Trigger events in causal order.
    for (const event of events) {
      if (event.type === 'on') {
        event.off.callback = this.sendNoteOn(
          event.frequency,
          event.rawAttack,
          event.time
        );
      } else if (event.type === 'off') {
        event.callback(event.rawRelease, event.time);
      }
    }
  }

  /**
   * Clear scheduled notes that have not yet been played.
   * Will start working once the Chrome bug is fixed: https://bugs.chromium.org/p/chromium/issues/detail?id=471798
   */
  clear() {
    if (this.output !== null) {
      this.output.clear();
      this.output.sendAllNotesOff();
    }
    this.lastEventTime = WebMidi.time;
  }
}

/**
 * Unique identifier for a note message in a specific channel.
 */
function noteIdentifier(event: NoteMessageEvent) {
  return event.note.number + 128 * event.message.channel;
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
  /** Note-off map from (noteNumber + midiChannel * 128) to callbacks.  */
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
    this.log(
      `Midi note on ${noteNumber} at velocity ${attack} on channel ${event.message.channel}`
    );
    const noteOff = this.callback(noteNumber, rawAttack);
    this.noteOffMap.set(noteIdentifier(event), noteOff);
  }

  private noteOff(event: NoteMessageEvent) {
    if (!this.channels.has(event.message.channel)) {
      return;
    }
    const noteNumber = event.note.number;
    const release = event.note.release;
    const rawRelease = event.note.rawRelease;
    this.log(
      `Midi note off ${noteNumber} at velocity ${release} on channel ${event.message.channel}`
    );
    const id = noteIdentifier(event);
    const noteOff = this.noteOffMap.get(id);
    if (noteOff !== undefined) {
      this.noteOffMap.delete(id);
      noteOff(rawRelease);
    }
  }

  /**
   * Fire global note-off.
   */
  deactivate() {
    for (const [id, noteOff] of this.noteOffMap) {
      this.noteOffMap.delete(id);
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
