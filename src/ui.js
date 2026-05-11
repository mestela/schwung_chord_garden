import {
    Black, White, LightGrey, Red, Blue,
    MidiNoteOn, MidiNoteOff, MidiCC,
    MoveShift, MoveMainKnob, MovePads, MoveBack, MoveMainButton
} from '/data/UserData/schwung/shared/constants.mjs';

import {
    isNoiseMessage, isCapacitiveTouchMessage,
    setLED, clearAllLEDs, decodeDelta
} from '/data/UserData/schwung/shared/input_filter.mjs';

/* State */
let selectedChordType = 0; // Index in chordTypes
let activeNotes = {}; // Track active notes per trigger pad
let midiChannel = 0; // Default to channel 0 (Track 1 usually)
let inParamsPage = false;
let mode = 0; // 0: Standard, 1: Extended
let leftPadsHeld = {}; // Track held state of left pads for Extended mode
let hostShiftHeld = false;
let selectedParamIdx = 0; // 0: Channel, 1: Mode
let isEditingParam = false;
let octaveOffset = 0; // Transpose in octaves (semitones)
let selectedInversion = 0; // 0: Root, 1: 1st, 2: 2nd, 3: 3rd
let bassOctaveOffset = -24; // Default to 2 octaves down
let velocityOffset = 0; // Default to no change (-64 to +64)

let currentPadsLEDState = new Array(32).fill(-1); // -1 means unknown
let nextPadToRefresh = 0; // For round-robin LED updates

const stateFilePath = "/data/UserData/schwung/modules/overtake/schwung-chord-garden/state.json";

function saveState() {
    if (typeof host_write_file !== "function") return;
    const state = {
        mode: mode,
        midiChannel: midiChannel,
        octaveOffset: octaveOffset,
        selectedInversion: selectedInversion,
        bassOctaveOffset: bassOctaveOffset,
        velocityOffset: velocityOffset
    };
    host_write_file(stateFilePath, JSON.stringify(state));
    unified_log("CG", "State saved.");
}

function loadState() {
    if (typeof host_read_file !== "function") return;
    const content = host_read_file(stateFilePath);
    if (content) {
        try {
            const state = JSON.parse(content);
            if (state.mode !== undefined) mode = state.mode;
            if (state.midiChannel !== undefined) midiChannel = state.midiChannel;
            if (state.octaveOffset !== undefined) octaveOffset = state.octaveOffset;
            if (state.selectedInversion !== undefined) selectedInversion = state.selectedInversion;
            if (state.bassOctaveOffset !== undefined) bassOctaveOffset = state.bassOctaveOffset;
            if (state.velocityOffset !== undefined) velocityOffset = state.velocityOffset;
            unified_log("CG", "State loaded.");
        } catch (e) {
            unified_log("CG", "Error parsing state: " + e);
        }
    }
}

function chokeAllNotes() {
    for (const root in activeNotes) {
        const notes = activeNotes[root];
        for (const note of notes) {
            const statusWithChannel = (MidiNoteOff & 0xF0) | midiChannel;
            move_midi_inject_to_move([0x8, statusWithChannel, note, 0]);
        }
    }
    activeNotes = {};
}

const chordTypes = [
    { name: "Major", intervals: [0, 4, 7] },
    { name: "Minor", intervals: [0, 3, 7] },
    { name: "7",     intervals: [0, 4, 7, 10] },
    { name: "Maj7",  intervals: [0, 4, 7, 11] },
    { name: "m7",    intervals: [0, 3, 7, 10] },
    { name: "9",     intervals: [0, 4, 7, 10, 14] },
    { name: "Sus2",  intervals: [0, 2, 7] },
    { name: "Sus4",  intervals: [0, 5, 7] }
];

const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function getNoteName(note) {
    return noteNames[note % 12];
}

function getActiveModifiers() {
    let typeStr = "";
    let extStr = "";
    if (leftPadsHeld[0]) typeStr = "dim";
    else if (leftPadsHeld[1]) typeStr = "m";
    else if (leftPadsHeld[2]) typeStr = "Maj";
    else if (leftPadsHeld[3]) typeStr = "sus";
    
    if (leftPadsHeld[8]) extStr += "6";
    if (leftPadsHeld[9]) extStr += "7";
    if (leftPadsHeld[10]) extStr += "Maj7";
    if (leftPadsHeld[11]) extStr += "9";
    
    return typeStr + extStr;
}

/* Display state */
let line1 = "Chord Garden";
let line2 = "Ready";
let line3 = "";
let line4 = "";

function drawUI() {
    clear_screen();
    if (inParamsPage) {
        print(2, 2, "Parameters", 1);
        
        const channelStr = `MIDI Channel: ${midiChannel + 1}`;
        const modeStr = `Mode: ${mode === 0 ? "Standard" : "Extended"}`;
        const velStr = `Vel Offset: ${velocityOffset}`;
        
        if (selectedParamIdx === 0) {
            print(2, 18, `${isEditingParam ? "* " : "> "}${channelStr}`, 1);
            print(2, 34, `  ${modeStr}`, 1);
            print(2, 50, `  ${velStr}`, 1);
        } else if (selectedParamIdx === 1) {
            print(2, 18, `  ${channelStr}`, 1);
            print(2, 34, `${isEditingParam ? "* " : "> "}${modeStr}`, 1);
            print(2, 50, `  ${velStr}`, 1);
        } else {
            print(2, 18, `  ${channelStr}`, 1);
            print(2, 34, `  ${modeStr}`, 1);
            print(2, 50, `${isEditingParam ? "* " : "> "}${velStr}`, 1);
        }
    } else {
        print(2, 2, line1, 1);
        print(2, 18, line2, 1);
        print(2, 34, line3, 1);
        
        if (mode === 1) { // Extended
            const mods = getActiveModifiers();
            print(2, 50, `Active: ${mods || "None"}`, 1);
        } else {
            print(2, 50, line4, 1);
        }
    }
}

function displayMessage(l1, l2, l3, l4) {
    if (l1 !== undefined) line1 = l1;
    if (l2 !== undefined) line2 = l2;
    if (l3 !== undefined) line3 = l3;
    if (l4 !== undefined) line4 = l4;
}

function updatePads() {
    clearAllLEDs();
}

function playChord(rootNote, isOn, velocity) {
    const status = isOn ? MidiNoteOn : MidiNoteOff;
    const type = isOn ? 0x9 : 0x8;
    const statusWithChannel = (status & 0xF0) | midiChannel;
    
    if (!isOn) {
        const notes = activeNotes[rootNote] || [];
        for (const note of notes) {
            move_midi_inject_to_move([0x8, statusWithChannel, note, 0]);
        }
        delete activeNotes[rootNote];
        displayMessage(undefined, undefined, "", "");
        return;
    }

    chokeAllNotes();
    
    const chord = chordTypes[selectedChordType];
    activeNotes[rootNote] = [];
    displayMessage(undefined, undefined, `Playing ${chord.name}`, `Root: ${rootNote}`);
    
    for (const interval of chord.intervals) {
        const note = rootNote + interval;
        if (note >= 0 && note <= 127) {
            move_midi_inject_to_move([type, statusWithChannel, note, velocity]);
            unified_log("CG", `Sent note: ${note} (root: ${rootNote}, interval: ${interval})`);
            activeNotes[rootNote].push(note);
        }
    }
}

function playExtendedChord(rootNote, isOn, velocity) {
    const status = isOn ? MidiNoteOn : MidiNoteOff;
    const type = isOn ? 0x9 : 0x8;
    const statusWithChannel = (status & 0xF0) | midiChannel;
    
    if (!isOn) {
        const notes = activeNotes[rootNote] || [];
        for (const note of notes) {
            move_midi_inject_to_move([0x8, statusWithChannel, note, 0]);
        }
        delete activeNotes[rootNote];
        displayMessage(undefined, undefined, "", "");
        return;
    }

    chokeAllNotes();
    
    let intervals = [0]; // Always include root
    
    // Add bass note
    intervals.push(bassOctaveOffset);
    
    if (leftPadsHeld[0]) intervals = intervals.concat([3, 6]); // Dim
    else if (leftPadsHeld[1]) intervals = intervals.concat([3, 7]); // Min
    else if (leftPadsHeld[2]) intervals = intervals.concat([4, 7]); // Maj
    else if (leftPadsHeld[3]) intervals = intervals.concat([5, 7]); // Sus (Sus4)
    
    // Extenders (can be stacked)
    if (leftPadsHeld[8]) intervals.push(9); // 6
    if (leftPadsHeld[9]) intervals.push(10); // m7
    if (leftPadsHeld[10]) intervals.push(11); // M7
    if (leftPadsHeld[11]) intervals.push(14); // 9
    
    // Remove duplicates and sort
    intervals = Array.from(new Set(intervals)).sort((a, b) => a - b);
    
    // Apply inversion
    if (selectedInversion > 0) {
        for (let i = 0; i < selectedInversion && i < intervals.length; i++) {
            intervals[i] += 12;
        }
    } else if (selectedInversion < 0) {
        const count = Math.abs(selectedInversion);
        for (let i = 0; i < count && i < intervals.length; i++) {
            intervals.sort((a, b) => b - a); // Sort descending to find highest
            intervals[i] -= 12;
        }
    }
    // Remove duplicates again after inversion!
    intervals = Array.from(new Set(intervals)).sort((a, b) => a - b);
    
    // Apply velocity offset
    const newVelocity = isOn ? Math.min(Math.max(velocity + velocityOffset, 1), 127) : 0;
    
    const noteName = getNoteName(rootNote);
    const mods = getActiveModifiers();
    const chordName = noteName + mods + (selectedInversion !== 0 ? ` inv${selectedInversion}` : "");
    
    activeNotes[rootNote] = [];
    displayMessage(undefined, undefined, `Playing: ${chordName}`, `Octave: ${octaveOffset/12}`);
    
    for (const interval of intervals) {
        let note = rootNote + interval + octaveOffset;
        
        // Wrap around if out of MIDI range
        while (note > 127) note -= 12;
        while (note < 0) note += 12;
        
        move_midi_inject_to_move([type, statusWithChannel, note, newVelocity]);
        unified_log("CG", `Sent note: ${note} (root: ${rootNote}, interval: ${interval})`);
        activeNotes[rootNote].push(note);
    }
}

globalThis.onMidiMessageExternal = function (data) {
    // Handle external MIDI if needed
};

globalThis.onMidiMessageInternal = function (data) {
    if (isNoiseMessage(data)) return;
    if (isCapacitiveTouchMessage(data)) return;

    const status = data[0] & 0xF0;
    const d1 = data[1];
    const d2 = data[2];

    const isNote = status === MidiNoteOn || status === MidiNoteOff;
    const isNoteOn = status === MidiNoteOn;
    const isCC = status === MidiCC;

    if (isCC && d1 === MoveShift) {
        hostShiftHeld = (d2 > 0);
    }

    if (isCC && d1 === MoveMainButton && d2 > 0) {
        if (!inParamsPage) {
            inParamsPage = true;
            selectedParamIdx = 0;
            isEditingParam = false;
        } else {
            isEditingParam = !isEditingParam;
        }
        return;
    }

    if (inParamsPage) {
        if (isCC && d1 === MoveMainKnob) {
            const delta = decodeDelta(d2);
            if (delta !== 0) {
                if (isEditingParam) {
                    // Edit value
                    if (selectedParamIdx === 0) {
                        midiChannel = (midiChannel + delta + 16) % 16;
                        saveState();
                    } else if (selectedParamIdx === 1) {
                        mode = (mode + delta + 2) % 2;
                        updatePads(); // Update LEDs if mode changed
                        saveState();
                    } else if (selectedParamIdx === 2) {
                        velocityOffset = Math.min(Math.max(velocityOffset + delta, -64), 64);
                        saveState();
                    }
                } else {
                    // Scroll parameters
                    selectedParamIdx = (selectedParamIdx + delta + 3) % 3;
                }
            }
            return;
        }
        if (isCC && d1 === MoveBack && d2 > 0) {
            if (isEditingParam) {
                isEditingParam = false; // Cancel/Return to scroll
            } else {
                inParamsPage = false; // Exit params page
            }
            return;
        }
    }

    if (isCC && d1 === MoveBack && d2 > 0) {
        if (typeof host_exit_module === "function") {
            host_exit_module();
        } else if (typeof shadow_request_exit === "function") {
            shadow_request_exit();
        }
        return;
    }

    if (isNote) {
        const note = d1;
        const velocity = d2;

        if (MovePads.includes(note)) {
            const padIdx = MovePads.indexOf(note);
            const isOn = isNoteOn && velocity > 0;
            
            unified_log("CG", `Pad event: note=${note}, idx=${padIdx}, isOn=${isOn}`);
            
            const col = padIdx % 8;
            const row = Math.floor(padIdx / 8);
            
            if (col < 4) { // Left side
                if (mode === 0) { // Standard
                    const typeIdx = (Math.floor(padIdx / 8) * 4) + (padIdx % 8);
                    if (isOn && typeIdx < chordTypes.length) {
                        selectedChordType = typeIdx;
                        displayMessage(undefined, `Selected: ${chordTypes[selectedChordType].name}`, "", "");
                        updatePads();
                    }
                } else { // Extended
                    if (row >= 2) {
                        // Control area (Top left)
                        if (isOn) {
                            if (col === 0) {
                                if (row === 3) octaveOffset = Math.min(octaveOffset + 12, 48);
                                if (row === 2) octaveOffset = Math.max(octaveOffset - 12, -48);
                                displayMessage(undefined, `Octave: ${octaveOffset/12}`, "", "");
                            } else if (col === 1) {
                                if (row === 3) selectedInversion = Math.min(selectedInversion + 1, 10);
                                if (row === 2) selectedInversion = Math.max(selectedInversion - 1, -10);
                                displayMessage(undefined, `Inversion: ${selectedInversion}`, "", "");
                                updatePads();
                            } else if (col === 2) {
                                if (row === 3) bassOctaveOffset = Math.min(bassOctaveOffset + 12, 0);
                                if (row === 2) bassOctaveOffset = Math.max(bassOctaveOffset - 12, -48);
                                displayMessage(undefined, `Bass Octave: ${bassOctaveOffset/12}`, "", "");
                                updatePads();
                            }
                            saveState();
                        }
                    } else if (row === 1) {
                        // Chord types
                        leftPadsHeld[col] = isOn; // Map col to type (0: Dim, 1: Min, 2: Maj, 3: Sus)
                        updatePads();
                    } else if (row === 0) {
                        // Extenders
                        leftPadsHeld[8 + col] = isOn; // Map col to extender (8: 6, 9: m7, 10: M7, 11: 9)
                        updatePads();
                    }
                }
            } else {
                const noteIdx = (Math.floor(padIdx / 8) * 4) + (padIdx % 8 - 4);
                if (mode === 0) { // Standard
                    playChord(72 + noteIdx, isOn, velocity);
                } else { // Extended
                    playExtendedChord(72 + noteIdx, isOn, velocity);
                }
                
                // Feedback LED removed for Dark Mode
            }
            return;
        }
    }
};

globalThis.init = function () {
    unified_log("CG", "init starting");
    displayMessage("Chord Garden", "Ready", "", "");
    loadState();
    clearAllLEDs();
    unified_log("CG", "init finished");
};

globalThis.tick = function () {
    drawUI();
};
