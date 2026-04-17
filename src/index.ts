import {
  ControlChangeMessageEvent,
  NoteMessageEvent,
  Output,
  Input,
  Utilities,
  WebMidi,
} from 'webmidi';
import {ftom} from 'xen-dev-utils/conversion';

/**
 * Pitch bend range measured in semitones (+-).
 */
export const BEND_RANGE_IN_SEMITONES = 2;

// Large but finite number to signify voices that are off
const EXPIRED = 10000;

// Cents offset tolerance for channel reuse.
const EPSILON = 1e-6;

const DAMPERPEDAL = Utilities.getCcNumberByName('damperpedal');
const SOSTENUTO = Utilities.getCcNumberByName('sostenuto');

if (DAMPERPEDAL === undefined || SOSTENUTO === undefined) {
  throw new Error('Failed to resolve pedal controller numbers from webmidi.');
}

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
  /** Frequency in Hertz (Hz). */
  frequency: number;
  /** Attack velocity from 0 to 127. */
  rawAttack?: number;
  /** Release velocity from 0 to 127. */
  rawRelease?: number;
  /**
   * Note-on time in milliseconds (ms) as measured by `WebMidi.time`.
   *
   * - If this is a number, it is treated as an absolute WebMidi timestamp.
   * - If this is a string prefixed with `"+"`, the note is delayed by that many milliseconds from the moment `playNotes` is called.
   * - Otherwise, a string is parsed as a numeric absolute timestamp in milliseconds.
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

export type MidiOutOptions = {
  /**
   * Optional logger for outgoing MIDI note events.
   */
  log?: (msg: string) => void;
};

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
   * Construct a new wrapper for a webmidi.js output.
   * @param output Output device or `null` if you need a dummy out.
   * @param channels Channels to use for sending pitch bent MIDI notes. Number of channels determines maximum microtonal polyphony.
   * @param options Optional output behavior flags and logger.
   */
  constructor(
    output: Output | null,
    channels: Set<number>,
    options: MidiOutOptions = {},
  ) {
    this.output = output;
    this.channels = channels;
    if (options.log === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      this.log = msg => {};
    } else {
      this.log = options.log;
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
          0,
        );
      });
    }
  }

  /**
   * Select a voice that's using a cents offset compatible channel or the oldest voice if nothing can be re-used.
   * @param centsOffset Cents offset (pitch-bend) from 12edo.
   * @returns A voice for the next note-on event.
   */
  private selectVoice(centsOffset: number) {
    // Age signifies how many note-ons have occurred after voice initialization.
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
   * Send a note-on event and pitch-bend to the output device on one of the available channels.
   * @param frequency Frequency of the note in Hertz (Hz).
   * @param rawAttack Attack velocity of the note from 0 to 127.
   * @returns A callback for sending a corresponding note off on the correct channel.
   */
  sendNoteOn(
    frequency: number,
    rawAttack?: number,
    time?: DOMHighResTimeStamp,
  ): NoteOff {
    if (time === undefined) {
      time = WebMidi.time;
    }
    if (time < this.lastEventTime) {
      throw new Error(
        `Events must be triggered in causal order: ${time} < ${this.lastEventTime} (note on)`,
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
        (rawAttack ?? 64) / 127
      } on channel ${
        voice.channel
      } with bend ${centsOffset} resulting from frequency ${frequency}`,
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
          `Events must be triggered in causal order: ${time} < ${this.lastEventTime} (note off)`,
        );
      }
      this.lastEventTime = time;

      this.log(
        `Sending note off ${noteNumber} at velocity ${
          (rawRelease ?? 64) / 127
        } on channel ${voice.channel}`,
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
   * Notes are converted to note-on/off events, sorted by timestamp, and then emitted in causal order.
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
          event.time,
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
  return event.note.number + 128 * (event.message.channel - 1); // webmidi sends channels 1-16, but identifier only needs to range between 0 and (16 * 128) - 1 = 2047
}

/**
 * MIDI channel number (1-16) from a note identifier.
 */
function channelFromIdentifier(identifier: number) {
  return Math.floor(identifier / 128) + 1;
}

/**
 * Function to call when a MIDI note-on event is received (e.g. for turning on your synth).
 * Attack velocity is from 0 to 127.
 * Must return a note-off callback (e.g. for turning off your synth).
 */
export type NoteOnCallback = (
  index: number,
  rawAttack: number,
  channel: number,
) => NoteOff;

export type MidiInOptions = {
  /**
   * If true, hold pedal (CC64, sustain) and sostenuto (CC66) can delay note-off callbacks.
   */
  sustainPedal?: boolean;
  /**
   * Optional logger for incoming MIDI note events.
   */
  log?: (msg: string) => void;
};

/**
 * Wrapper for webmidi.js input.
 * Listens on multiple channels.
 */
export class MidiIn {
  callback: NoteOnCallback;
  channels: Set<number>;
  /** Note-off map from (noteNumber + (midiChannel - 1) * 128) to callbacks.  */
  private noteOffMap: Map<number, NoteOff>;
  /** Deferred note-offs while pedals are holding notes. */
  private deferredNoteOffMap: Map<number, number | undefined>;
  /** Channels where hold pedal (CC64) is currently active. */
  private holdPedalChannels: Set<number>;
  /** Channels where sostenuto pedal (CC66) is currently active. */
  private sostenutoChannels: Set<number>;
  /** Note identifiers physically held down by keyboard state. */
  private heldNoteIds: Set<number>;
  /** Sostenuto-captured note identifiers by MIDI channel. */
  private sostenutoNoteIdsByChannel: Map<number, Set<number>>;
  private sustainPedalEnabled: boolean;
  private _noteOn: (event: NoteMessageEvent) => void;
  private _noteOff: (event: NoteMessageEvent) => void;
  private _controlChange: (event: ControlChangeMessageEvent) => void;
  log: (msg: string) => void;

  /**
   * Construct a new wrapper for a webmidi.js input device.
   * @param callback Function to call when a note-on event is received on any of the available channels.
   * @param channels Channels to listen on.
   * @param options Optional MIDI input behavior flags and logger.
   */
  constructor(
    callback: NoteOnCallback,
    channels: Set<number>,
    options: MidiInOptions = {},
  ) {
    this.callback = callback;
    this.channels = channels;
    this.sustainPedalEnabled = options.sustainPedal === true;
    this.noteOffMap = new Map();
    this.deferredNoteOffMap = new Map();
    this.holdPedalChannels = new Set();
    this.sostenutoChannels = new Set();
    this.heldNoteIds = new Set();
    this.sostenutoNoteIdsByChannel = new Map();

    this._noteOn = this.noteOn.bind(this);
    this._noteOff = this.noteOff.bind(this);
    this._controlChange = this.controlChange.bind(this);

    if (options.log === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      this.log = msg => {};
    } else {
      this.log = options.log;
    }
  }

  /**
   * Make this wrapper (and your callback) respond to note-on/off events from this MIDI input.
   * @param input MIDI input to listen to.
   */
  listen(input: Input) {
    input.addListener('noteon', this._noteOn);
    input.addListener('noteoff', this._noteOff);
    if (this.sustainPedalEnabled) {
      input.addListener('controlchange', this._controlChange);
    }
  }

  /**
   * Make this wrapper (and your callback) stop responding to note-on/off events from this MIDI input.
   * @param input MIDI input that was listened to.
   */
  unlisten(input: Input) {
    input.removeListener('noteon', this._noteOn);
    input.removeListener('noteoff', this._noteOff);
    if (this.sustainPedalEnabled) {
      input.removeListener('controlchange', this._controlChange);
    }
  }

  private noteOn(event: NoteMessageEvent) {
    const channel = event.message.channel;
    if (!this.channels.has(channel)) {
      return;
    }
    const noteNumber = event.note.number;
    const attack = event.note.attack;
    const rawAttack = event.note.rawAttack;
    // Some MIDI devices encode note-off as note-on with velocity 0.
    if (rawAttack === 0) {
      this.noteOff(event);
      return;
    }
    this.log(
      `Midi note on ${noteNumber} at velocity ${attack} on channel ${channel}`,
    );
    const id = noteIdentifier(event);
    this.heldNoteIds.add(id);
    const existingNoteOff = this.noteOffMap.get(id);
    if (existingNoteOff !== undefined) {
      this.deferredNoteOffMap.delete(id);
      this.getSostenutoNotes(channel).delete(id);
      this.noteOffMap.delete(id);
      existingNoteOff();
    }

    const noteOff = this.callback(noteNumber, rawAttack, channel);
    this.noteOffMap.set(id, noteOff);
  }

  private noteOff(event: NoteMessageEvent) {
    const channel = event.message.channel;
    if (!this.channels.has(channel)) {
      return;
    }
    const noteNumber = event.note.number;
    const release = event.note.release;
    const rawRelease = event.note.rawRelease;
    this.log(
      `Midi note off ${noteNumber} at velocity ${release} on channel ${channel}`,
    );
    const id = noteIdentifier(event);
    this.heldNoteIds.delete(id);
    if (this.sustainPedalEnabled && this.shouldDeferNoteOff(channel, id)) {
      this.deferredNoteOffMap.set(id, rawRelease);
      return;
    }
    this.triggerNoteOff(id, rawRelease);
  }

  private controlChange(event: ControlChangeMessageEvent) {
    const channel = event.message.channel;
    if (!this.channels.has(channel)) {
      return;
    }
    if (
      event.controller.number !== DAMPERPEDAL &&
      event.controller.number !== SOSTENUTO
    ) {
      return;
    }
    const rawValue =
      typeof event.rawValue === 'number'
        ? event.rawValue
        : typeof event.value === 'number'
          ? event.value
          : event.value === true
            ? 127
            : 0;
    if (event.controller.number === DAMPERPEDAL && rawValue >= 64) {
      this.holdPedalChannels.add(channel);
      return;
    }
    if (event.controller.number === DAMPERPEDAL && rawValue < 64) {
      if (!this.holdPedalChannels.has(channel)) {
        return;
      }
      this.holdPedalChannels.delete(channel);
      this.releaseDeferredNoteOffs(channel);
      return;
    }
    if (event.controller.number === SOSTENUTO && rawValue >= 64) {
      this.sostenutoChannels.add(channel);
      const captured = this.getSostenutoNotes(channel);
      captured.clear();
      for (const id of this.heldNoteIds) {
        if (channelFromIdentifier(id) === channel) {
          captured.add(id);
        }
      }
      return;
    }
    if (!this.sostenutoChannels.has(channel)) {
      return;
    }
    this.sostenutoChannels.delete(channel);
    this.getSostenutoNotes(channel).clear();
    this.releaseDeferredNoteOffs(channel);
  }

  private releaseDeferredNoteOffs(channel: number) {
    for (const [id, rawRelease] of this.deferredNoteOffMap) {
      if (channelFromIdentifier(id) !== channel) {
        continue;
      }
      if (this.shouldDeferNoteOff(channel, id)) {
        continue;
      }
      this.triggerNoteOff(id, rawRelease);
    }
  }

  private shouldDeferNoteOff(channel: number, id: number) {
    if (this.holdPedalChannels.has(channel)) {
      return true;
    }
    return (
      this.sostenutoChannels.has(channel) &&
      this.getSostenutoNotes(channel).has(id)
    );
  }

  private getSostenutoNotes(channel: number) {
    let notes = this.sostenutoNoteIdsByChannel.get(channel);
    if (notes === undefined) {
      notes = new Set();
      this.sostenutoNoteIdsByChannel.set(channel, notes);
    }
    return notes;
  }

  private triggerNoteOff(id: number, rawRelease?: number) {
    const noteOff = this.noteOffMap.get(id);
    if (noteOff !== undefined) {
      this.deferredNoteOffMap.delete(id);
      this.noteOffMap.delete(id);
      noteOff(rawRelease);
    }
  }

  /**
   * Fire global note-off.
   */
  deactivate() {
    for (const [id, noteOff] of this.noteOffMap) {
      this.deferredNoteOffMap.delete(id);
      this.noteOffMap.delete(id);
      noteOff(80);
    }
    this.heldNoteIds.clear();
    this.holdPedalChannels.clear();
    this.sostenutoChannels.clear();
    this.sostenutoNoteIdsByChannel.clear();
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
