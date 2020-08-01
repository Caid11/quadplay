/* By Morgan McGuire @CasualEffects https://casual-effects.com LGPL 3.0 License */

// quadplay runtime and hardware layer.
//
// Variables named with a leading underscore are illegal in quadplay/pyxlscript, and
// will therefore such variables and functions in this file will not be visible to
// the program.

'use strict';

var $Object = Object;
var $console = console;
var $Math = Math;

var $gameMode = undefined, $prevMode = undefined;
var $numBootAnimationFrames = 120;

// Modes from pop_mode. Does not contain $gameMode
var $modeStack = [], $prevModeStack = [];

// Overriden by setFramebufferSize()
var $SCREEN_WIDTH = 384, $SCREEN_HEIGHT = 224;

var $previousModeGraphicsCommandList = [];

// Does not contain $previousModeGraphicsCommandList
var $previousModeGraphicsCommandListStack = [];
var $frameHooks = [];

var game_frames = 0;
var mode_frames = 0;

// Graphics execute once out of this many frames.  Must be 1 (60 Hz),
// 2 (30 Hz), 3 (20 Hz), or 4 (15 Hz). This is managed by
// quadplay-ide.js. Note that game logic always executes at 60 Hz.
var $graphicsPeriod = 1;

// Time spent in graphics this frame
var $graphicsTime = 0;

// Only used on Safari
var $currentLineNumber = 0;

var $mode_framesStack = [];

var $postFX;

var is_NaN = Number.isNaN;

// Maps container objects to the count of how many iterators
// they are currently used within, so that the runtime can
// detect when they are illegally being mutated.
var $iteratorCount = new WeakMap();


function $checkContainer(container) {
    if (! Array.isArray(container) && (typeof container !== 'string') && (typeof container !== 'object')) {
        $error('The container used with a for...in loop must be an object, string, or array.');
    }
}

function reset_post_effects() {
    $postFX = {
        background: {r:0, g:0, b:0, a:0},
        color: {r:0, g:0, b:0, a:0},
        blendMode: "source-over",
        pixelate: 0,
        scale: {x: 1, y: 1},
        angle: 0,
        pos: {x:0, y:0},
        opacity: 1
    };
}

reset_post_effects();

function get_post_effects() {
    return clone($postFX);
}

function set_post_effects(args) {
    if (args.background !== undefined) {
        $postFX.background.r = (args.background.r !== undefined) ? args.background.r : 0;
        $postFX.background.g = (args.background.g !== undefined) ? args.background.g : 0;
        $postFX.background.b = (args.background.b !== undefined) ? args.background.b : 0;
        $postFX.background.a = (args.background.a !== undefined) ? args.background.a : 1;
    }

    if (args.color !== undefined) {
        $postFX.color.r = (args.color.r !== undefined) ? args.color.r : 0;
        $postFX.color.g = (args.color.g !== undefined) ? args.color.g : 0;
        $postFX.color.b = (args.color.b !== undefined) ? args.color.b : 0;
        $postFX.color.a = (args.color.a !== undefined) ? args.color.a : 1;
    }

    switch (args.blendMode) {
    case undefined: break;
    case 'source-over':
    case 'hue':
    case 'multiply':
    case 'difference':
        $postFX.blendMode = args.blendMode;
        break;
    default: throw new Error('Illegal blendMode for post effects: "' + args.blendMode + '"');
    }

    if (args.scale !== undefined) {
        if (typeof args.scale === 'number') {
            $postFX.scale.x = $postFX.scale.y = args.scale;
        } else {
            $postFX.scale.x = (args.scale.x !== undefined) ? args.scale.x : 1;
            $postFX.scale.y = (args.scale.y !== undefined) ? args.scale.y : 1;
        }
    }

    if (args.angle !== undefined) {
        $postFX.angle = args.angle;
    }

    if (args.pos !== undefined) {
        $postFX.pos.x = (args.pos.x !== undefined) ? args.pos.x : SCREEN_WIDTH / 2;
        $postFX.pos.y = (args.pos.y !== undefined) ? args.pos.y : SCREEN_HEIGHT / 2;
    }
    
    if (args.opacity !== undefined) {
        $postFX.opacity = args.opacity;
    }
}


function delay(callback, frames) {
    return add_frame_hook(undefined, callback, frames || 0);
}


function sequence(...seq) {
    // Is there any work?
    if (seq.length === 0) { return; }
    
    let totalLifetime = 0;
    let queue = [];
    
    for (let i = 0; i < seq.length; ++i) {
        if (typeof seq[i] === 'function' || seq === undefined) {
            ++totalLifetime;
            queue.push({callback: seq[i], frames: 1})
        } else {
            const frames = $Math.max(1, $Math.round(seq[i].frames || 1));
            totalLifetime += frames;
            queue.push({callback: seq[i].callback, frames: frames})
        }
    }
    
    let currentFrame = 0;
    function update(framesleft, lifetime) {
        if (queue.length === 0) {
            remove_frame_hook(hook);
            return;
        }
        
        const step = queue[0];
        
        if (step.callback) {
            const result = step.callback(step.frames - currentFrame - 1, step.frames);
            if (result === sequence.BREAK) {
                remove_frame_hook(hook);
                return;
            } else if (result === sequence.NEXT) {
                // Immediately advance
                pop_front(queue);
                currentFrame = 0;
                return;
            }
        }
        ++currentFrame;

        if (currentFrame >= step.frames) {
            pop_front(queue);
            currentFrame = 0;
        }
    }

    const hook = add_frame_hook(update, undefined, totalLifetime);

    return hook;
}

sequence.NEXT = ["NEXT"];
sequence.BREAK = ["BREAK"];



function add_frame_hook(callback, endCallback, frames, mode) {
    if (mode === undefined) { mode = get_mode(); }
    if (isNaN(frames)) { $error("NaN frames on add_frame_hook()"); }
    const hook = {$callback:callback, $endCallback:endCallback, $mode:mode, $frames:frames, $maxFrames:frames};
    $frameHooks.push(hook);
    return hook;
}


function remove_frame_hook(hook) {
    remove_values($frameHooks, hook);
}


function remove_frame_hooks_by_mode(mode) {
    for (let i = 0; i < $frameHooks.length; ++i) {
        if ($frameHooks[i].$mode === mode) {
            $frameHooks[i] = $frameHooks[$frameHooks.length - 1];
            --i;
            --$frameHooks.length;
        }
    }
}


function $processFrameHooks() {
    for (let i = 0; i < $frameHooks.length; ++i) {
        const hook = $frameHooks[i];
        if ((hook.$mode === undefined) || (hook.$mode === $gameMode)) {
            --hook.$frames;
            const r = hook.$callback ? hook.$callback(hook.$frames, hook.$maxFrames) : 0;

            // Remove the callback *before* it executes so that if
            // a set_mode happens within the callback it does not re-trigger
            if (r || (hook.$frames <= 0)) {
                $frameHooks[i] = $frameHooks[$frameHooks.length - 1];
                --i;
                --$frameHooks.length;
            }
            
            if (! r && (hook.$frames <= 0)) {
                // End hook
                if (hook.$endCallback) { hook.$endCallback(); }
            }

        }
    }        
}


function draw_previous_mode() {
    Array.prototype.push.apply($graphicsCommandList, $previousModeGraphicsCommandList);
}

////////////////////////////////////////////////////////////////////
// Array

function last_value(s) {
    return s[s.length - 1];
}

function last_key(s) {
    if (! Array.isArray(s) || typeof s === 'string') {
        throw new Error('Argument to last_key() must be a string or array');
    }
    return size(s) - 1;
}

function find(a, x, s) {
    s = s || 0;
    if (Array.isArray(a)) {
        const L = a.length;
        for (let i = s; i < L; ++i) {
            if (a[i] === x) { return i; }
        }
        return undefined;
    } else if (typeof a === 'string') {
        let i = a.indexOf(x, s);
        return (i === -1) ? undefined : i;
    } else {
        for (let k in a) {
            if (a[k] === x) { return k; }
        }
        return undefined;
    }
}


function insert(array, i, ...args) {
    if (! Array.isArray(array)) { throw new Error('insert(array, index, value) requires an array argument'); }
    if (typeof i !== 'number') { throw new Error('insert(array, index, value) requires a numeric index'); }
    array.splice(i, 0, ...args)
    return array[i];
}


function push(array, ...args) {
    if (! Array.isArray(array)) { throw new Error('push() requires an array argument'); }
    if ($iteratorCount.get(array)) {
        $error('Cannot push() while using a container in a for loop. Call clone() on the container in the for loop declaration.');
    }
    array.push(...args);
    return array[array.length - 1];
}


function push_front(array, ...args) {
    if (! Array.isArray(array)) { throw new Error('push_front() requires an array argument'); }
    if ($iteratorCount.get(array)) {
        $error('Cannot push_front() while using a container in a for loop. Call clone() on the container in the for loop declaration.');
    }
    array.unshift(...args);
    return array[0];
}


function pop_front(array) {
    if (! Array.isArray(array)) { throw new Error('pop_front() requires an array argument'); }
    if ($iteratorCount.get(array)) {
        $error('Cannot pop_front() while using a container in a for loop. Call clone() on the container in the for loop declaration.');
    }
    if (array.length === 0) { return undefined;  }
    return array.shift();
}


function pop(array) {
    if ($iteratorCount.get(array)) {
        $error('Cannot pop() while using a container in a for loop. Call clone() on the container in the for loop declaration.');
    }
    return array.pop();
}


function $defaultComparator(a, b) {
    return (a < b) ? -1 : (a > b) ? 1 : 0;
}

function $defaultReverseComparator(b, a) {
    return (a < b) ? -1 : (a > b) ? 1 : 0;
}


function sort(array, k, reverse) {
    let compare = k;
    
    if (compare === undefined) {
        if (typeof array[0] === 'object') {
            // Find the first property, alphabetically
            const keys = Object.keys();
            keys.sort();
            k = keys[0];
            if (reverse) {
                compare = function (a, b) { return $defaultComparator(a[k], b[k]); };
            } else {
                compare = function (a, b) { return $defaultComparator(b[k], a[k]); };
            }
        } else if (reverse) {
            // Just use the default reverse comparator
            compare = $defaultReverseComparator;
        } else {
            // Just use the default comparator
            compare = $defaultComparator;
        }
    } else if (typeof compare !== 'function') {
        // sort by index or key k
        if (reverse) {
            compare = function (a, b) { return $defaultComparator(b[k], a[k]); };
        } else {
            compare = function (a, b) { return $defaultComparator(a[k], b[k]); };
        }
    } else if (reverse) {
        compare = function (a, b) { return k(b, a); };
    }

    array.sort(compare);
}


function resize(a, n) {
    if ($iteratorCount.get(a)) {
        $error('Cannot resize() while using a container in a for loop. Call clone() on the container in the for loop declaration.');
    }
    a.length = n;
}

/////////////////////////////////////////////////////////////////////
//
// Table and Array

function size(x) {
    if (Array.isArray(x)) {
        return x.length;
    } else if (x === null || x === undefined) {
        return 0;
    } else {
        let tx = typeof x;
        if (tx === 'string') {
            return x.length;
        } else if (tx === 'object') {
            return Object.keys(x).length;
        } else {
            return 0;
        }
    }
}


function random_value(t) {
    const T = typeof t;
    if (Array.isArray(t) || (T === 'string')) {
        return t[random_integer(t.length - 1)];
    } else if (T === 'object') {
        const k = Object.keys(t);
        return t[k[random_integer(k.length - 1)]];
    } else {
        return undefined;
    }
}


function remove_all(t) {
    if ($iteratorCount.get(t)) {
        $error('Cannot remove_all() while using a container in a for loop. Call clone() on the container in the for loop declaration.');
    }
    if (Array.isArray(t)) {
        t.length = 0;
    } else {
        for (var key in t){
            if (t.hasOwnProperty(key)){
                delete t[key];
            }
        }
    }
}


function remove_values(t, value) {
    if ($iteratorCount.get(t)) {
        $error('Cannot remove_values() while using a container in a for loop. Call clone() on the container in the for loop declaration.');
    }
    
    if (Array.isArray(t)) {
        // Place to copy the next element to
        let dst = 0;
        for (let src = 0; src < t.length; ++src) {
            if (src > dst) { t[dst] = t[src]; }
            if (t[src] !== value) { ++dst; }
        }
        if (dst !== t.length) {
            t.length = dst;
        }
    } else if (typeof t === 'object') {
        for (let k in t) {
            if (t[k] === value) {
                delete t[k];
            }
        }
    }
}


function fast_remove_value(t, value) {
    if ($iteratorCount.get(t)) {
        $error('Cannot fast_remove_value() while using a container in a for loop. Call clone() on the container in the for loop declaration.');
    }
    if (Array.isArray(t)) {
        for (let i = 0; i < t.length; ++i) {
            if (t[i] === value) {
                t[i] = t[t.length - 1];                
                t.pop();
                return;
            }
        }
    } else if (typeof t === 'object') {
        for (let k in t) {
            if (t[k] === value) {
                delete t[k];
                return;
            }
        }
    }
}


function iterate(array, callback) {
    if (! is_string(callback) && !is_function(callback)) {
        $error('The callback to iterate() must be a function or string property name');
    }
    
    // Place to copy the next element to
    let dst = 0;
    let done = false;

    const stringCase = is_string(callback);

    $iteratorCount.set(array, ($iteratorCount.get(array) || 0) + 1);
    try {
        for (let src = 0; src < array.length; ++src) {
            const value = array[src]
            if (src > dst) { array[dst] = value; }
            
            let r = 0; // continue 
            if (done) {
                ++dst;
            } else {
                if (stringCase) {
                    const fcn = value[callback];
                    if (typeof fcn !== 'function') {
                        $error("value does not have callback in iterate()");
                    }
                    r = fcn(value);
                } else {
                    r = callback(value);
                }
                
                if (r === iterate.REMOVE_AND_BREAK) {
                    done = true;
                } else {
                    if (r === iterate.BREAK) {
                        if (src === dst) {
                            // Can stop immediately
                            return
                        } else {
                            // Have to continue iteration for removal copies
                            done = true;
                        }
                    }
                    
                    if (r !== iterate.REMOVE) {
                        ++dst;
                    }
                }
            }
        }
    } finally {
        $iteratorCount.set(array, $iteratorCount.get(array) - 1);
    }
                     
    // Remove extra elements
    resize(array, dst);
}

// Unique objects for ==
iterate.REMOVE = ["REMOVE"]
iterate.BREAK  = ["BREAK"]
iterate.REMOVE_AND_BREAK = ["REMOVE_AND_BREAK"]
iterate.CONTINUE = ["CONTINUE"]
Object.freeze(iterate);


function reverse(array) {
    if (! Array.isArray(array)) { throw new Error('reverse() takes an array as the argument'); }
    array.reverse();
}


function remove_key(t, i) {
    if ($iteratorCount.get(t)) {
        $error('Cannot remove_key() while using a container in a for loop. Call clone() on the container in the for loop declaration.');
    }
    if (Array.isArray(t)) {
        if (typeof i !== 'number') { throw 'remove_key(array, i) called with a key (' + i + ') that is not a number'; }
        t.splice(i, 1);
    } else if (typeof t === 'object') {
        delete t[i];
    }
}


function extend(a, b) {
    if ($iteratorCount.get(a)) {
        $error('Cannot extend() while using a container in a for loop. Call clone() on the container in the for loop declaration.');
    }
    if (Array.isArray(a)) {
        if (! Array.isArray(b)) {
            throw new Error('Both arguments to extend(a, b) must have the same type. Invoked with one array and one non-array.');
        }

        const oldLen = a.length;
        a.length += b.length;
        const newLen = a.length;
        for (let i = oldLen, j = 0; i < newLen; ++i, ++j) {
            a[i] = b[j];
        }
    } else {
        if (Array.isArray(b)) {
            throw new Error('Both arguments to extend(a, b) must have the same type. Invoked with one object and one array.');
        }
        // Object
        for (let k in b) {
            a[k] = b[k];
        }
    }
}


function array_value(animation, frame, extrapolate) {
    if (! Array.isArray(animation) && (typeof animation !== 'string')) {
        if (animation === undefined || animation === null) {
            throw new Error('Passed nil to array_value()');
        } else {
            throw new Error('The first argument to array_value() must be an array or string (was ' + unparse(animation)+ ')');
        }
    }
    
    frame = floor(frame);
    switch (extrapolate || animation.extrapolate || 'clamp') {
    case 'oscillate':
        frame = oscillate(frame, animation.length - 1);
        break;
    
    case 'loop':
        frame = loop(frame, animation.length);
        break;
        
    default:
        frame = $clamp(frame, 0, animation.length - 1)
    }
      
    return animation[frame];
}


function concatenate(a, b) {
    if (Array.isArray(a)) {
        if (! Array.isArray(b)) {
            throw new Error('Both arguments to concatenate(a, b) must have the same type. Invoked with one array and one non-array.');
        }
        a = clone(a);
        extend(a, b);
        return a;
    } else if (is_string(a)) {
        if (! is_string(b)) {
            throw new Error('Both arguments to concatenate(a, b) must have the same type. Invoked with one string and one non-string.');
        }
        return a + b;
    } else {
        if (Array.isArray(b)) {
            throw new Error('Both arguments to concatenate(a, b) must have the same type. Invoked with one object and one array.');
        }
        a = clone(a);
        extend(a, b);
        return a;
    }
}

var extended = concatenate;


function fast_remove_key(t, i) {
    if ($iteratorCount.get(t)) {
        $error('Cannot fast_remove_key() while using a container in a for loop. Call clone() on the container in the for loop declaration.');
    }
    if (Array.isArray(t)) {
        if (typeof i !== 'number') { throw 'fast_remove_key(array, i) called with a key (' + i + ') that is not a number'; }
        let L = t.length;
        t[i] = t[L - 1];
        t.length = L - 1;
    } else if (typeof t === 'object') {
        delete t[key];
    }
}


function keys(t) {
    return Object.keys(t);
}

function values(t) {
    return Object.values(t);
}


/////////////////////////////////////////////////////////////////////
//
// String

function starts_with(str, pattern) {
    return str.startsWith(pattern);
}

function ends_with(str, pattern) {
    return str.endsWith(pattern);
}

// Helper for replace()
function $entryKeyLengthCompare(a, b) {
    return b[0].length - a[0].length;
}

function replace(s, src, dst) {

    const ESCAPABLES = /([\/\,\!\\\^\$\{\}\[\]\(\)\.\*\+\?\|\<\>\-\&])/g;
    
    if (typeof s !== 'string') {
        throw new Error('The first argument to replace() must be a string');
    }
    
    if (s === '' || src === '') { return s; }

    if (typeof src === 'object') {
        if (dst !== undefined) {
            throw new Error("replace(string, object) requires exactly two arguments");
        }
        
        // Generate the replacement regexp that will find all target
        // patterns simultaneously.  We have to do this instead of
        // replacing sequentially because there might be cyclic
        // replacement patterns and we don't want to double-replace.
        //
        // In this pattern, escape any aspect of the target that would
        // be misinterpreted as a regexp character.
        let R = '';
        for (const pattern in src) {
            R += (R.length === 0 ? '' : '|') + pattern.replace(ESCAPABLES, '\\$&');
        }

        return s.replace(new RegExp(R, 'g'), function (match) {
            return src[match];
        });
        
    } else {
        // String replace
        if (dst === undefined || src === undefined) {
            throw new Error("Use replace(string, object) or replace(string, string, string)");
        }
        if (typeof src !== 'string') { src = unparse(src); }
        if (typeof dst !== 'string') { dst = unparse(dst); }

        // Escape any special characters, build a global replacement regexp, and then
        // run it on dst.
        src = src.replace(ESCAPABLES, '\\$&');
        dst = dst.replace(/\$/g, '$');
        return s.replace(new RegExp(src, 'g'), dst);
    }
}


function slice(a, s, e) {
    if (Array.isArray(a)) {
        return a.slice(s, e);
    } else if (is_string(a)) {
        return a.substr(s, e);
    } else {
        throw new Error('slice() requires an array or string argument.');
    }
}


//////////////////////////////////////////////////////////////////////
//

function make_spline(timeSrc, controlSrc, order, extrapolate) {
    // Argument checking
    if (controlSrc.length < 2) { throw new Error('Must specify at least two control points'); }
    if (order === undefined) { order = 3; }
    if (extrapolate === undefined) { extrapolate = 'stall'; }
    if (find(['stall', 'loop', 'clamp', 'continue', 'oscillate'], extrapolate) === undefined) {
        throw new Error('extrapolate argument to make_spline must be "stall", "loop", "clamp", or "continue"');
    }
    
    order = $Math.round(order);
    if (order === 2 || order < 0 || order > 3) { throw new Error('order must be 0, 1, or 3'); }

    // Clone the arrays
    const time = [], control = [];
    
    for (let i = 0; i < timeSrc.length; ++i) {
        time[i] = timeSrc[i];
        if ((i > 0) && (time[i] <= time[i - 1])) {
            throw new Error('times must increase through the array');
        }
        control[i] = clone(controlSrc[i]);
    }

    if (extrapolate === 'loop') {
        if (time.length !== controlSrc.length + 1) {
            throw new Error('There must be one more time than value to use "loop" extrapolation');
        }
        // Duplicate the last control point, which was previously null
        control[control.length - 1] = clone(control[0]);
    } else if (timeSrc.length !== controlSrc.length) {
        throw new Error('time and value arrays must have the same size');
    }   

    if (extrapolate === 'oscillate') {
        const N = control.length;

        // Convert to "loop"
        for (let i = 0; i < N - 1; ++i) {
            control[N + i] = control[N - i - 2];
            time[N + i] = time[N + i - 1] + (time[N - i - 1] - time[N - i - 2]);
        }
        extrapolate = 'loop';
    }

    // Number of control points, not included a potentially duplicated
    // one at the end to make wrapping math easier.
    const N = control.length - (extrapolate === 'loop' ? 1 : 0);


    // Time covered by all of the intervals between control points,
    // including the wrap one in loop mode. 
    const duration = time[time.length - 1] - time[0];

    /** Returns the requested control point and time sample based on
        array index.  If the array index is out of bounds, wraps (for
        a cyclic spline) or linearly extrapolates (for a non-cyclic
        spline), assuming time intervals follow the first or last
        sample recorded.

        Returns 0 if there are no control points.
    */
    function getControl(i, outTimeArray, outControlArray, outIndex) {
        let t, c;

        if (extrapolate === 'loop') {
            c = control[floor(loop(i, N))];
            if (i < 0) {
                // Wrapped around bottom

                // Number of times we wrapped around the cyclic array
                const wraps = floor((N + 1 - i) / N);
                const j = (i + wraps * N) % N;
                t = time[j] - wraps * duration;

            } else if (i < N) {
                // Normal case: no wrap
                t = time[i];

            } else {
                // Wrapped around top

                // Number of times we wrapped around the cyclic array
                const wraps = floor(i / N);
                const j = i % N;
                t = time[j] + wraps * duration;
            }

        } else if (i < 0) { // Not cyclic, off the low side

            // Step away from control point 0
            const dt = time[1] - time[0];
            
            if (extrapolate === 'continue') { // linear
                // Extrapolate (note; i is negative and an integer)
                c = lerp(control[0], control[1], i);
            } else {
                // Stall or clamp
                // Return the first, clamping the control point
                c = control[0];
            }
            t = dt * i + time[0];

        } else if (i >= N) { // Not cyclic, off the high side
            const dt = time[N - 1] - time[N - 2];
            
            if (extrapolate === 'continue') {
                // Extrapolate
                c = lerp(control[N - 2], control[N - 1], i - (N - 2));
            } else {
                // Stall or clamp
                // Return the last, clamping the control point
                c = control[N - 1];
            }
            // Extrapolate
            t = time[N - 1] + dt * (i - N + 1);

        } else {
            // Normal case: in bounds, no extrapolation needed
            c = control[i];
            t = time[i];
        }
        
        outControlArray[outIndex] = c;
        outTimeArray[outIndex] = t;
    }


    /** Derived from the G3D Innovation Engine (https://casual-effects.com/g3d).
        Assumes that time[0] <= s < time[N - 1] + time[0].  called by compute_index. Returns {i, u} */
    function computeIndexInBounds(s) {
        $console.assert((s < time[N - 1] + time[0]) && (time[0] <= s));
        const t0 = time[0];
        const tn = time[N - 1];

        if (s > time[N - 1]) {
            $console.assert(extrapolate === 'loop');
            return {i:N - 1, u:(s - time[N - 1]) / (time[N] - time[N - 1])};
        }

        // Guess a linear start index
        let i = floor((N - 1) * (s - t0) / (tn - t0));
    
        // Inclusive bounds for binary search
        let hi = N - 1;
        let lo = 0;
    
        while ((time[i] > s) || ((i < time.length - 1) && (time[i + 1] <= s))) {
            if (hi <= lo) {
                $console.log(lo, hi, i, s);
                throw new Error('Infinite loop?');
            }

            if (time[i] > s) {
                // value at current index is too big. Look on
                // the lower half.
                hi = i - 1;
            } else if (time[i + 1] <= s) {
                // value at current index is too small. Look
                // on the upper half
                lo = i + 1;
            }
            
            i = (hi + lo) >> 1;
        }
    
        // Having exited the above loop, i must be correct, so compute u.
        if (i === N - 1) {
            return {i:i, u:0};
        } else {
            return {i: i, u: (s - time[i]) / (time[i + 1] - time[i])};
        }
    }


    /**
       Given a time @a s, finds @a i and 0 <= @a u < 1 such that
       @a s = time[@a i] * @a u + time[@a i + 1] * (1 - @a u).  Note that
       @a i may be outside the bounds of the time and control arrays;
       use getControl to handle wraparound and extrapolation issues.
       
       This function takes expected O(1) time for control points with
       uniform time sampled control points or for uniformly
       distributed random time samples, but may take O( log time.size() ) time
       in the worst case.

       Called from evaluate(). returns {i, u}
    */
    function compute_index(s) {
        let i, u;
        const t0 = time[0];
        const tn = time[N - 1];
    
        if (extrapolate === 'loop') {
            // Cyclic spline
            if ((s < t0) || (s >= time[N])) {
                // Cyclic, off the bottom or top.
                // Compute offset and reduce to the in-bounds case.

                // Number of times we wrapped around the cyclic array
                const wraps = floor((s - t0) / duration);
                const result = computeIndexInBounds(s - duration * wraps);
                result.i += wraps * N;
                return result;
                
            } else if (s >= tn) {
                // Cyclic, off the top but before the end of the last interval
                i = N - 1;
                u = (s - tn) / (time[N] - tn);
                return {i:i, u:u};
            
            } else {
                // Cyclic, in bounds
                return computeIndexInBounds(s);
            }
            
        } else {
            // Non-cyclic
            if (s < t0) {
                // Non-cyclic, off the bottom.  Assume points are spaced
                // following the first time interval.
                const dt = time[1] - t0;
                const x = (s - t0) / dt;
                i = $Math.floor(x);
                u = x - i;
                return {i:i, u:u};
                
            } else if (s >= tn) {
                // Non-cyclic, off the top.  Assume points are spaced following
                // the last time interval.
                const dt = tn - time[N - 2];
                const x = (N - 1) + (s - tn) / dt;
                i = $Math.floor(x);
                u = x - i;
                return {i:i, u:u};
                
            } else {
                // In bounds, non-cyclic.  Assume a regular
                // distribution (which gives O(1) for uniform spacing)
                // and then binary search to handle the general case
                // efficiently.
                return computeIndexInBounds(s);
                
            } // if in bounds
        } // extrapolation Mode
    } // compute_index
    

    /* Derived from the G3D Innovation Engine (https://casual-effects.com/g3d).
       Return the position at time s.  The spline is defined outside
       of the time samples by extrapolation or cycling. */
    function evaluate(s) {
        if (extrapolate === 'clamp') {
            if (s < time[0]) { return clone(control[0]); }
            else if (s > time[N - 1]) { return clone(control[N - 1]); }
        }
        
        const indexResult = compute_index(s);
        // Index of the first control point
        const i = indexResult.i;
        // Fractional part of the time
        const u = indexResult.u;

        // Array of 4 control points and control times.
        // p[1] is the one below this time and p[2] is above it.
        // The others are needed to provide derivatives at the ends
        let p = [], t = [];
        for (let j = 0; j < N; ++j) {
            getControl(i + j - 1, t, p, j);
        }

        if (order === 0) {
            return clone(p[1]);
        } else if (order === 1) {
            const a = (s - t[1]) / (t[2] - t[1]);
            return lerp(p[1], p[2], a);
        }

        // Time deltas
        const dt0 = t[1] - t[0];
        const dt1 = t[2] - t[1];
        const dt2 = t[3] - t[2];

        const dp0 = _sub(p[1], p[0]);
        const dp1 = _sub(p[2], p[1]);
        const dp2 = _sub(p[3], p[2]);

        // The factor of 1/2 from averaging two time intervals is 
        // already factored into the basis
        
        // tan1 = (dp0 / dt0 + dp1 / dt1) * ((dt0 + dt1) * 0.5);
        // The last term normalizes for unequal time intervals
        const x = (dt0 + dt1) * 0.5;
        
        const n0 = x / dt0;
        const n1 = x / dt1;
        const n2 = x / dt2;

        const dp1n1 = _mul(dp1, n1);
        
        const tan1 = _add(_mul(dp0, n0), dp1n1);
        const tan2 = _add(dp1n1, _mul(dp2, n2));

        // Powers of the fractional part, u
        const uvec = [u * u * u, u * u, u, 1];

        // Compute the weights on each of the control points/tangents
        const basis = [ 0.5,  2.0, -2.0,  0.5,
                       -1.0, -3.0,  3.0, -0.5,
                        0.5,  0.0,  0.0,  0.0,
                       -0.0,  1.0,  0.0,  0.0];

        // Matrix product
        const weights = [0, 0, 0, 0];
        for (let i = 0; i < 4; ++i) {
            for (let j = 0; j < 4; ++j) {
                weights[i] += uvec[j] * basis[i + 4 * j];
            }
        }

        return _add(_add(
                    _add(_mul(tan1, weights[0]),
                         _mul(p[1], weights[1])),
                         _mul(p[2], weights[2])),
                         _mul(tan2, weights[3]));
    }

    return evaluate;
}

//////////////////////////////////////////////////////////////////////
//
// Function

function call(f) {
    return Function.call.apply(f, arguments);
}

//////////////////////////////////////////////////////////////////////

/** Callback to show the screen buffer and yield to the browser. Set by
    reloadRuntime() */
var $submitFrame = null;

// Scissor (set_clipping) region. This is inclusive and is expressed in
// terms of pixel indices.
var $clipY1 = 0, $clipY2 = $SCREEN_HEIGHT - 1, $clipZ1 = -2047, $clipX1 = 0, $clipX2 = $SCREEN_WIDTH - 1, $clipZ2 = 2048;

// Transform
var $offsetX = 0, $offsetY = 0, $offsetZ = 0, $scaleX = 1, $scaleY = 1, $scaleZ = 1, $skewXZ = 0, $skewYZ = 0;

// Camera
var $camera = {
    // Raw fields
    x:     0,
    y:     0,
    z:     0,
    angle: 0,
    zoom:  1
};

var $graphicsStateStack = [];


function $pushGraphicsState() {
    $graphicsStateStack.push({
        cx1:$clipX1, cy1:$clipY1, cz1:$clipZ1,
        cx2:$clipX2, cy2:$clipY2, cz2:$clipZ2, 
        ax:$offsetX, ay:$offsetY, az:$offsetZ,
        sx:$scaleX,  sy:$scaleY,  sz:$scaleZ,
        kx:$skewXZ,  ky:$skewYZ,

        camera_x: $camera.x,
        camera_y: $camera.y,
        camera_z: $camera.z,
        camera_angle: $camera.angle,
        camera_zoom: $camera.zoom
    });
}


function $popGraphicsState() {
    const s = $graphicsStateStack.pop();
    $offsetX = s.ax; $offsetY = s.ay; $offsetZ = s.az;
    $scaleX = s.sx; $scaleY = s.sy; $scaleZ = s.sz;
    $skewXZ = s.kx; $skewYZ = s.ky;

    $clipX1 = s.cx1; $clipY1 = s.cy1; $clipZ1 = s.cz1;
    $clipX2 = s.cx2; $clipY2 = s.cy2; $clipZ2 = s.cz2;

    $camera.x = s.camera_x;
    $camera.y = s.camera_y;
    $camera.z = s.camera_z;
    $camera.angle = s.camera_angle;
    $camera.zoom = s.camera_zoom;

}


function reset_camera() {
    set_camera({x:0, y:0}, 0, 1, 0);
}


function set_camera(pos, angle, zoom, z) {
    if (is_object(pos) && (pos.x === undefined)) {
        zoom = pos.zoom;
        angle = pos.angle;
        z = pos.z;
        pos = pos.pos;
    }

    if (pos === undefined) { pos = {x:0, y:0}; }
    if (zoom === undefined) { zoom = 1; }

    if (typeof zoom !== 'number' && typeof zoom !== 'function') {
        throw new Error('zoom argument to set_camera() must be a number or function');
    }
    if (typeof zoom === 'number' && (zoom <= 0 || !(zoom < Infinity))) {
        throw new Error('zoom argument to set_camera() must be positive and finite');
    }
    $camera.x = pos.x;
    $camera.y = pos.y;
    $camera.z = z || 0;
    $camera.angle = angle || 0;
    $camera.zoom = zoom;
}


function get_camera() {
    return {
        pos: xy($camera.x, $camera.y),
        angle: $camera.angle,
        zoom: $camera.zoom,
        z: $camera.z
    };
}

function get_transform() {
    return {pos:  xy($offsetX, $offsetY),
            dir:  xy($scaleX, $scaleY),
            z:    $offsetZ,
            zDir: $scaleZ,
            skew: xy($skewXZ, $skewYZ)
           };
}


function rotation_sign() {
    return -$Math.sign($scaleX * $scaleY);
}


function up_y() {
    return -$Math.sign($scaleY);
}


function reset_transform() {
    $offsetX = $offsetY = $offsetZ = $skewXZ = $skewYZ = 0;
    $scaleX = $scaleY = $scaleZ = 1;
}


function compose_transform(pos, dir, addZ, scaleZ, skew) {
    if (is_object(pos) && (('pos' in pos) || ('dir' in pos) || ('z' in pos) || ('skew' in pos))) {
        // Argument version
        return compose_transform(pos.pos, pos.dir, pos.z, pos.skew);
    }
    let addX, addY, scaleX, scaleY, skewXZ, skewYZ;
    if (pos !== undefined) {
        if (is_number(pos)) { throw new Error("pos argument to compose_transform() must be an xy() or nil"); }
        addX = pos.x; addY = pos.y;
    }
    if (dir !== undefined) { scaleX = dir.x; scaleY = dir.y; }
    if (skew !== undefined) { skewXZ = skew.x; skewYZ = skew.y; }

    // Any undefined fields will default to the reset values
    if (addX === undefined) { addX = 0; }
    if (addY === undefined) { addY = 0; }
    if (addZ === undefined) { addZ = 0; }
    if (scaleX === undefined) { scaleX = 1; }
    if (scaleY === undefined) { scaleY = 1; }
    if (scaleZ === undefined) { scaleZ = 1; }
    if (skewXZ === undefined) { skewXZ = 0; }
    if (skewYZ === undefined) { skewYZ = 0; }

    // Composition derivation under the "new transformation happens first" model:
    //
    // Basic transforms:
    // screen.x = (draw.x + skew.x * draw.z) * dir.x + pos.x
    // screen.y = (draw.y + skew.y * draw.z) * dir.y + pos.y
    // screen.z = draw.z * zDir + z
    //
    // screen.z = (draw.z * zDirNew + addZNew) * zDirOld + addZOld
    //          = draw.z * zDirNew * zDirOld + addZNew * zDirOld + addZOld
    //          = draw.z * (zDirNew * zDirOld) + (addZNew * zDirOld + addZOld)
    //   zAddNet = addZNew * zDirOld + addZOld
    //   zDirNet = zDirNew * zDirOld
    //
    // screen.x = (((draw.x + skewNew.x * draw.z) * dirNew.x + posNew.x) + skew.x * draw.z) * dir.x + pos.x
    //          = (draw.x * dirNew.x + skewNew.x * draw.z * dirNew.x + skew.x * draw.z) * dir.x + posNew.x * dir.x + pos.x
    //          = (draw.x + draw.z * [skewNew.x + skew.x/dirNew.x]) * [dir.x * dirNew.x] + posNew.x * dir.x + pos.x
    //     netAdd.x = posNew.x * dir.x + pos.x
    //     netSkew.x = skewNew.x + skew.x / dirNew.x
    //     netDir.x = dir.x * dirNew.x
    

    // Order matters because these calls mutate the parameters.
    $offsetX = addX * $scaleX + $offsetX;
    $skewXZ  = skewXZ + $skewXZ / $scaleX;
    $scaleX  = scaleX * $scaleX;

    $offsetY = addY * $scaleY + $offsetY;
    $skewYZ  = skewYZ + $skewYZ / $scaleY;
    $scaleY  = scaleY * $scaleY;
    
    $offsetZ = addZ * $scaleZ + $offsetZ;
    $scaleZ  = scaleZ * $scaleZ;    
}


function set_transform(pos, dir, addZ, scaleZ, skew) {
    if (arguments.length === 0) { throw new Error("set_transform() called with no arguments"); }
    if (is_object(pos) && (('pos' in pos) || ('dir' in pos) || ('z' in pos) || ('skew' in pos))) {
        // Argument version
        return set_transform(pos.pos, pos.dir, pos.z, pos.skew);
    }

    let addX, addY, scaleX, scaleY, skewXZ, skewYZ;
    if (pos !== undefined) {
        if (is_number(pos)) { throw new Error("pos argument to set_transform() must be an xy() or nil"); }
        addX = pos.x; addY = pos.y;
    }
    if (dir !== undefined) { scaleX = dir.x; scaleY = dir.y; }
    if (skew !== undefined) { skewXZ = skew.x; skewYZ = skew.y; }

    // Any undefined fields will default to their previous values
    if (addX === undefined) { addX = $offsetX; }
    if (addY === undefined) { addY = $offsetY; }
    if (addZ === undefined) { addZ = $offsetZ; }
    if (scaleX === undefined) { scaleX = $scaleX; }
    if (scaleY === undefined) { scaleY = $scaleY; }
    if (scaleZ === undefined) { scaleZ = $scaleZ; }
    if (skewXZ === undefined) { skewXZ = $skewXZ; }
    if (skewYZ === undefined) { skewYZ = $skewYZ; }
    
    $offsetX = addX;
    $offsetY = addY;
    $offsetZ = addZ;

    $scaleX = (scaleX === -1) ? -1 : +1;
    $scaleY = (scaleY === -1) ? -1 : +1;
    $scaleZ = (scaleZ === -1) ? -1 : +1;

    $skewXZ = skewXZ;
    $skewYZ = skewYZ;
}


function intersect_clip(pos, size, z1, z_size) {
    if (pos && (pos.pos || pos.size || (pos.z !== undefined) || (pos.z_size !== undefined))) {
        return intersect_clip(pos.pos, pos.size, pos.z, pos.z_size);
    }

    let x1, y1, dx, dy, dz;
    if (pos !== undefined) {
        if (is_number(pos)) { throw new Error('pos argument to set_clip() must be an xy() or nil'); }
        x1 = pos.x; y1 = pos.y;
    }
    if (size !== undefined) {
        if (is_number(size)) { throw new Error('size argument to set_clip() must be an xy() or nil'); }
        dx = size.x; dy = size.y;
    }
    
    if (x1 === undefined) { x1 = $clipX1; }
    if (y1 === undefined) { y1 = $clipY1; }
    if (z1 === undefined) { z1 = $clipZ1; }
    if (dx === undefined) { dx = $clipX2 - $clipX1 + 1; }
    if (dy === undefined) { dy = $clipY2 - $clipY1 + 1; }
    if (dz === undefined) { dz = $clipZ2 - $clipZ1 + 1; }

    let x2 = x1 + dx, y2 = y1 + dy, z2 = z1 + dz;

    // Order appropriately
    if (x2 < x1) { let temp = x1; x1 = x2; x2 = temp; }
    if (y2 < y1) { let temp = y1; y1 = y2; y2 = temp; }
    if (z2 < z1) { let temp = z1; z1 = z2; z2 = temp; }
    
    x1 = $Math.round(x1);
    y1 = $Math.round(y1);
    z1 = $Math.round(z1);

    x2 = $Math.floor(x2 - 0.5);
    y2 = $Math.floor(y2 - 0.5);
    z2 = $Math.floor(z2 - 0.5);

    $clipX1 = $clamp($Math.max(x1, $clipX1), 0, $SCREEN_WIDTH - 1);
    $clipY1 = $clamp($Math.max(y1, $clipY1), 0, $SCREEN_HEIGHT - 1);
    $clipZ1 = $clamp($Math.max(z1, $clipZ1), -2047, 2048);
    
    $clipX2 = $clamp($Math.min(x2, $clipX2), 0, $SCREEN_WIDTH - 1);
    $clipY2 = $clamp($Math.min(y2, $clipY2), 0, $SCREEN_HEIGHT - 1);
    $clipZ2 = $clamp($Math.min(z2, $clipZ2), -2047, 2048);
}


function reset_clip() {
    $clipX1 = $clipY1 = 0;
    $clipZ1 = -2047;
    $clipX2 = $SCREEN_WIDTH - 1;
    $clipY2 = $SCREEN_HEIGHT - 1;
    $clipZ2 = 2048;
}


function get_clip() {
    return {
        pos:    {x:$clipX1, y:$clipY1},
        size:   {x:$clipX2 - $clipX1 + 1, y:$clipY2 - $clipY1 + 1},
        z:      $clipZ1,
        z_size:  $clipZ2 - $clipZ1 + 1
    };
}


function set_clip(pos, size, z1, dz) {
    if (pos && (pos.pos || pos.size || (pos.z !== undefined) || (pos.z_size !== undefined))) {
        return set_clip(pos.pos, pos.size, pos.z, pos.z_size);
    }
    
    let x1, y1, dx, dy;
    if (pos !== undefined) {
        if (is_number(pos)) { throw new Error('pos argument to set_clip() must be an xy() or nil'); }
        x1 = pos.x; y1 = pos.y;
    }
    if (size !== undefined) {
        if (is_number(size)) { throw new Error('size argument to set_clip() must be an xy() or nil'); }
        dx = size.x; dy = size.y;
    }
    
    if (x1 === undefined) { x1 = $clipX1; }
    if (y1 === undefined) { y1 = $clipY1; }
    if (z1 === undefined) { z1 = $clipZ1; }
    if (dx === undefined) { dx = $clipX2 - $clipX1 + 1; }
    if (dy === undefined) { dy = $clipY2 - $clipY1 + 1; }
    if (dz === undefined) { dz = $clipZ2 - $clipZ1 + 1; }

    let x2 = x1 + dx, y2 = y1 + dy, z2 = z1 + dz;

    // Order appropriately
    if (x2 < x1) { let temp = x1; x1 = x2; x2 = temp; }
    if (y2 < y1) { let temp = y1; y1 = y2; y2 = temp; }
    if (z2 < z1) { let temp = z1; z1 = z2; z2 = temp; }
    
    x1 = $Math.round(x1);
    y1 = $Math.round(y1);
    z1 = $Math.round(z1);

    x2 = $Math.floor(x2 - 0.5);
    y2 = $Math.floor(y2 - 0.5);
    z2 = $Math.floor(z2 - 0.5);

    $clipX1 = $clamp(x1, 0, $SCREEN_WIDTH - 1);
    $clipY1 = $clamp(y1, 0, $SCREEN_HEIGHT - 1);
    $clipZ1 = $clamp(z1, -2047, 2048);
    
    $clipX2 = $clamp(x2, 0, $SCREEN_WIDTH - 1);
    $clipY2 = $clamp(y2, 0, $SCREEN_HEIGHT - 1);
    $clipZ2 = $clamp(z2, -2047, 2048);
}


function abs(x) {
    return (x.length !== undefined) ? x.length : $Math.abs(x);
}

var sin = $Math.sin;
var cos = $Math.cos;
var tan = $Math.tan;
var acos = $Math.acos;
var asin = $Math.asin;
var log = $Math.log;
var log2 = $Math.log2;
var log10 = $Math.log10;
var exp = $Math.exp;
var sqrt = $Math.sqrt;
var cbrt = $Math.cbrt;

function sign_nonzero(x) { return (x < 0) ? -1 : 1; }

function atan(y, x) {
    if (typeof y === 'number') { return $Math.atan2(y, x); }
    return $Math.atan2(y.y, y.x);
}

var $screen;


/** List of graphics commands to be sorted and then executed by show(). */
var $previousGraphicsCommandList = [];
var $graphicsCommandList = [];
var $background = Object.seal({r:0,g:0,b:0,a:1});

var joy = null; // initialized by reloadRuntime()
var gamepad_array = null; // initialized by reloadRuntime()

var $hashview = new DataView(new ArrayBuffer(8));

var $customPauseMenuOptions = [];

function _hash(d) {
    // 32-bit FNV-1a
    var hval = 0x811c9dc5;
    
    if (d.length) {
        // String
        for (var i = d.length - 1; i >= 0; --i) {
            hval ^= d.charCodeAt(i);
            hval += (hval << 1) + (hval << 4) + (hval << 7) + (hval << 8) + (hval << 24);
        }
    } else {
        // Number
        $hashview.setFloat64(0, d);
        for (var i = 7; i >= 0; --i) {
            hval ^= $hashview.getUint8(i);
            hval += (hval << 1) + (hval << 4) + (hval << 7) + (hval << 8) + (hval << 24);
        }

        // Near integers, FNV sometimes does a bad job because it doesn't
        // mix the low bits enough. XOR with some well-distributed
        // bits
        hval ^= ($fract($Math.sin(d * 10) * 1e6) * 0xffffffff) | 0;
    }
    
    // Force to unsigned 32-bit
    return (hval >>> 0);
}


function hash(x, y) {
    var h = _hash(x);
    if (y !== undefined) {
        var hy = _hash(y);
        h ^= ((hy >> 16) & 0xffff) | ((hy & 0xffff) << 16);
    }
    
    return $Math.abs(h) / 0xffffffff;
}

function _lerp(a, b, t) { return a * (1 - t) + b * t; }

// Fast 1D "hash" used by noise()
function _nhash1(n) { n = $Math.sin(n) * 1e4; return n - $Math.floor(n); }

// bicubic fbm value noise
// from https://www.shadertoy.com/view/4dS3Wd
function noise(octaves, x, y, z) {
    if (Array.isArray(x)) {
        z = x[2];
        y = x[1];
        x = x[0];
    } else if (x.x !== undefined) {
        z = x.z;
        y = x.y;
        x = x.x;
    }
    
    // Set any missing axis to zero
    x = x || 0;
    y = y || 0;
    z = z || 0;

    let temp = $Math.round(octaves);
    if (octaves - k > 1e-10) {
        // Catch the common case where the order of arguments was swapped
        // by recognizing fractions in the octave value
        throw new Error("noise(octaves, x, y, z) must take an integer number of octaves");
    } else {
        octaves = temp | 0;
    }

    // Maximum value is 1/2 + 1/4 + 1/8 ... from the straight summation
    // The max is always pow(2,-octaves) less than 1.
    // So, divide by (1-pow(2,-octaves))
    octaves = $Math.max(1, octaves);

    
    var v = 0, k = 1 / (1 - $Math.pow(2, -octaves));

    var stepx = 110, stepy = 241, stepz = 171;
    
    for (; octaves > 0; --octaves) {
        
        var ix = $Math.floor(x), iy = $Math.floor(y), iz = $Math.floor(z);
        var fx = x - ix,        fy = y - iy,        fz = z - iz;
 
        // For performance, compute the base input to a 1D hash from the integer part of the argument and the 
        // incremental change to the 1D based on the 3D -> 1D wrapping
        var n = ix * stepx + iy * stepy + iz * stepz;

        var ux = fx * fx * (3 - 2 * fx),
            uy = fy * fy * (3 - 2 * fy),
            uz = fz * fz * (3 - 2 * fz);

        v += (_lerp(_lerp(_lerp(_nhash1(n), _nhash1(n + stepx), ux),
                          _lerp(_nhash1(n + stepy), _nhash1(n + stepx + stepy), ux), uy),
                    _lerp(_lerp(_nhash1(n + stepz), _nhash1(n + stepx + stepz), ux),
                          _lerp(_nhash1(n + stepy + stepz), _nhash1(n + stepx + stepy + stepz), ux), uy), uz) - 0.5) * k;

        // Grab successive octaves from very different parts of the space, and
        // double the frequency
        x = 2 * x + 109;
        y = 2 * y + 31;
        z = 2 * z + 57;
        k *= 0.5;
    }
    
    return v;
}


function _noop() {}


function vec(x, y, z, w) {
    if (w !== undefined) {
        return {x:x, y:y, z:z, w:w}
    } else if (z !== undefined) {
        return {x:x, y:y, z:z}
    } else {
        return {x:x, y:y}
    }
}

function $error(msg) {
    throw new Error(msg);
}


function $todo(msg) {
    if (msg === undefined) {
        throw new Error("Unimplemented");
    } else {
        throw new Error("Unimplemented: " + $unparse(msg));
    }
}


function xy(x, y) {
    if (x === undefined) {
        $error('nil or no argument to xy()');
    }
    
    if (x.x !== undefined) {
        if (y !== undefined) { $error('xy(number, number), xy(xy), xy(xyz), or xy(array) are the only legal options'); }
        return {x:x.x, y:x.y};
    }
    if (Array.isArray(x)) { return {x:x[0], y:x[1]}; }
    if (arguments.length !== 2) { $error('xy() cannot take ' + arguments.length + ' arguments.'); }
    if (typeof y !== 'number') { $error('The second argument to xy(x, y) must be a number'); }
    return {x:x, y:y};
}

function xz_to_xyz(v, new_z) {
    return {x:v.x, y: v.z, z: new_z || 0};
}

function xy_to_xyz(v, z) {
    return {x:v.x, y: v.y, z: z || 0};
}

function xz(x, z) {
    if (x === undefined) {
        $error('nil or no argument to xz()');
    }
    
    if (x.x !== undefined) { // xz(xyz)
        if (z !== undefined) { $error('xz(number, number), xz(xz), xz(xyz), or xz(array) are the only legal options'); }
        return {x:x.x, z:x.z};
    }
    if (Array.isArray(x)) { return {x:x[0], z:x[1]}; }
    if (arguments.length !== 2) { $error('xz() cannot take ' + arguments.length + ' arguments.'); }
    if (typeof z !== 'number') { $error('The second argument to xz(x, z) must be a number'); }
    return {x:x, z:z};
}


function xy_to_xz(v) {
    return {x: v.x, z: v.y};
}


function xz_to_xy(v) {
    return {x: v.x, y: v.z};
}


function xyz(x, y, z) {
    if (x.x !== undefined) {
        if (x.z !== undefined) { 
            if (x.y === undefined) { // xyz(xz)
                return {x:x.x, y:(y === undefined ? 0 : y), z:x.z};
            } else { // xyz(xyz) {
                if (y !== undefined) { $error('Cannot run xyz(xyz, z)'); }
                return {x:x.x, y:x.y, z:x.z};
            }
        } else { // xyz(xy, y default 0)
            return {x:x.x, y:x.y, z:(y === undefined ? 0 : y)}
        }
    }
    if (Array.isArray(x)) { return {x:x[0], y:x[1], z:x[2]}; }
    if (arguments.length !== 3) { throw new Error('xyz() requires exactly three arguments'); }
    return {x:x, y:y, z:z};
}


function rgb_to_xyz(c) {
    return {x:c.r, y:c.g, z:c.b};
}


function xyz_to_rgb(v) {
    return {r: v.x, g: v.y, b: v.z};
}


function equivalent(a, b) {
    switch (typeof a) {
    case 'number':
    case 'string':
    case 'function':
        return a === b;
        
    default:
        if (a.length !== b.length) { return false; }
        for (let key in a) if (a[key] !== b[key]) { return false; }
        return true;
    }
}


function gray(r) {
    if (r.h !== undefined) {
        // HSV -> RGB
        r = rgb(r);
    }
    
    if (r.r !== undefined) {
        // RGB -> grayscale. We're in sRGB space, where the actual grayscale conversion has to
        // be nonlinear, so this is a very coarse approximation.
        r = r.r * 0.35 + r.g * 0.50 + r.b * 0.15;
    }
    
    return rgb(r, r, r);
}


function rgb(r, g, b) {
    if (arguments.length !== 3 && arguments.length !== 1) { throw new Error('rgb() requires exactly one or three arguments or one hsv value'); }

    if (r.h !== undefined) {
        // Convert HSV --> RGB
        const h = _loop(r.h, 0, 1), s = $clamp(r.s, 0, 1), v = $clamp(r.v, 0, 1);
        let k = (5 + 6 * h) % 6;
        r = v - v * s * $Math.max(0, $Math.min(k, 4 - k, 1));

        k = (3 + 6 * h) % 6;
        g = v - v * s * $Math.max(0, $Math.min(k, 4 - k, 1));

        k = (1 + 6 * h) % 6;
        b = v - v * s * $Math.max(0, $Math.min(k, 4 - k, 1));
        /*
        r = v * (1 - s + s * $clamp($Math.abs($fract(h +  1 ) * 6 - 3) - 1, 0, 1));
        g = v * (1 - s + s * $clamp($Math.abs($fract(h + 2/3) * 6 - 3) - 1, 0, 1));
        b = v * (1 - s + s * $clamp($Math.abs($fract(h + 1/3) * 6 - 3) - 1, 0, 1));
*/
    } else if (r.r !== undefined) {
        // Clone
        g = r.g;
        b = r.b;
        r = r.r;
    } else {
        r = $clamp(r, 0, 1);
        g = $clamp(g, 0, 1);
        b = $clamp(b, 0, 1);
    }
    
    return {r:r, g:g, b:b};
}


function rgba(r, g, b, a) {
    if (r.h !== undefined) {
        // Convert to RGB
        const c = rgb(r);

        // add a
        if (r.a !== undefined) {
            c.a = r.a;
        } else {
            c.a = (g === undefined ? 1 : g);
        }
        return c;
    } else if (r.r !== undefined) {
        // Clone, maybe overriding alpha
        a = (r.a === undefined) ? (g === undefined ? 1 : g) : r.a;
        g = r.g;
        b = r.b;
        r = r.r;
    } else {
        r = $clamp(r, 0, 1);
        g = $clamp(g, 0, 1);
        b = $clamp(b, 0, 1);
        a = $clamp(a, 0, 1);
    }
    
    return {r:r, g:g, b:b, a:a};
}


function hsv(h, s, v) {
    if (h.r !== undefined) {
        // Convert RGB -> HSV
        const r = $clamp(h.r, 0, 1), g = $clamp(h.g, 0, 1), b = $clamp(h.b, 0, 1);

        v = $Math.max(r, g, b);

        if (v <= 0) {
            // Black
            h = 0; s = 0;
        } else {
            const lowest = $Math.min(r, g, b);

            // (highest - lowest) / highest = 1 - lowest / v
            s = 1 - lowest / v;
            const diff = v - lowest;

            if (diff > 0) {
                // Choose range based on which is the highest
                if (r === v)      { h =     (g - b) / diff; } // between yellow & magenta
                else if (g === v) { h = 2 + (b - r) / diff; } // between cyan & yellow
                else              { h = 4 + (r - g) / diff; } // between magenta & cyan
            } else {
                h = 0;
            }
            
            h /= 6;
            if (h < 0) { h += 1; }
        }
    } else if (h.h) {
        // Clone hsv or hsva -> hsv
        v = h.v;
        s = h.s;
        h = h.h;
    }

    return {h:h, s:s, v:v};
}


function hsva(h, s, v, a) {
    if (h.r !== undefined) {
        const c = hsv(h);
        c.a = (h.a !== undefined) ? h.a : 1;
        return c;
    } else if (h.h !== undefined) {
        // Clone, or hsv -> hsva
        a = (h.a === undefined) ? 1 : h.a;
        v = h.v;
        s = h.s;
        h = h.h;
    }
    
    return {h:h, s:s, v:v, a:a};
}


$Math.mid = function(a, b, c) {
    if (a < b) {
        if (b < c) {
            // a < b < c
            return b;
        } else if (a < c) {
            // a < c <= b
            return c;
        } else {
            // c <= a < b
            return a;
        }
    } else if (a < c) {
        return a;
    } else if (b < c) {
        // b < c <= a
        return c;
    } else {
        return b;
    }
}

function _lerp(x, y, a) { return (1 - a) * x + a * y; }
function $clamp(x, lo, hi) { return $Math.min($Math.max(x, lo), hi); }
function $fract(x) { return x - $Math.floor(x); }
function _square(x) { return x * x; }

/*************************************************************************************/
// Entity functions

function transform_es_to_sprite_space(entity, coord) {
    if (! entity || entity.pos === undefined |! coord || coord.x === undefined) { throw new Error("Requires both an entity and a coordinate"); }
    return xy(coord.x * $scaleX + entity.sprite.size.x * 0.5,
              coord.y * $scaleY + entity.sprite.size.y * 0.5);
}


function transform_sprite_space_to_es(entity, coord) {
    if (! entity || entity.pos === undefined |! coord || coord.x === undefined) { throw new Error("Requires both an entity and a coordinate"); }
    if (! entity.sprite) { throw new Error('Called transform_sprite_space_to_es() on an entity with no sprite property.'); }
    return xy((coord.x - entity.sprite.size.x * 0.5) / $scaleX,
              (coord.y - entity.sprite.size.y * 0.5) / $scaleY);
}


function draw_entity(e, recurse) {
    if (e === undefined) { throw new Error("nil entity in draw_entity()"); }
    if (recurse === undefined) { recurse = true; }

    if ($showEntityBoundsEnabled) {
        draw_bounds(e, false);
    }
    
    if (e.sprite) {
        // Shift the transform temporarily to support the offset without
        // memory allocation
        const oldX = $offsetX, oldY = $offsetY;
        $offsetX += e.offset.x * $scaleX; $offsetY += e.offset.y * $scaleY;
        draw_sprite(e.sprite, e.pos, e.angle, e.scale, e.opacity, e.z, e.sprite_override_color);
        $offsetX = oldX; $offsetY = oldY;
    }

    if (e.child_array && recurse) {
        const N = e.child_array.length;
        for (let i = 0; i < N; ++i) {
            draw_entity(e.child_array[i], recurse);
        }
    }

    if (e.labelFont && e.labelText) {
        const oldX = $offsetX, oldY = $offsetY;
        $offsetX += (e.offset.x + e.text_offset.x) * $scaleX; $offsetY += (e.offset.y + e.text_offset.y) * $scaleY;
        draw_text(e.font, e.text, e.pos, e.text_color, e.text_shadow, e.text_outline, e.text_x_align, e.text_y_align, e.z);
        $offsetX = oldX; $offsetY = oldY;
    }
}


// Not public because it isn't a very good test yet.
function _isEntity(e) {
    return e.shape && e.pos && e.vel && e.acc;
}


var _entityID = 0;
function make_entity(e, childTable) {
    const r = Object.assign({}, e || {});    

    if (e.shape && (e.shape !== 'rect') && (e.shape !== 'disk')) {
        throw new Error('Illegal shape for entity: "' + e.shape + '"');
    }

    // Clone vector components
    r.pos = r.pos ? clone(r.pos) : xy(0, 0);
    r.vel = r.vel ? clone(r.vel) : xy(0, 0);
    r.acc = r.acc ? clone(r.acc) : xy(0, 0);
    r.force = r.force ? clone(r.force) : xy(0, 0);

    r.restitution = (r.restitution === undefined) ? 0.1 : r.restitution;
    r.friction    = (r.friction === undefined) ? 0.15 : r.friction;
    r.drag        = (r.drag === undefined) ? 0.005 : r.drag;
    r.stiction_factor = (r.stiction_factor === undefined) ? 1 : r.stiction_factor;

    r.angle = r.angle || 0;
    r.spin = r.spin || 0;
    r.twist = r.twist || 0;
    r.torque = r.torque || 0;
    
    r.sprite_override_color = clone(r.sprite_override_color);
    
    r.scale = r.scale ? clone(r.scale) : xy(1, 1);
    r.offset = r.offset ? clone(r.offset) : xy(0, 0);
    
    // Assign empty fields with reasonable defaults
    r.name = r.name || ('entity' + (_entityID++));
    r.shape = r.shape || 'rect';
    r.sprite = r.sprite || undefined;
    r.z = r.z || 0;

    r.physics_sleep_state = r.physics_sleep_state || 'awake';

    r.contact_group = r.contact_group || 0;
    r.contact_category_mask = (r.contact_category_mask === undefined) ? 1 : r.contact_category_mask;
    r.contact_hit_mask = (r.contact_hit_mask === undefined) ? 0xffffffff : r.contact_hit_mask;
    r.is_sensor = (r.is_sensor === undefined) ? false : r.is_sensor;

    if (r.density === undefined) { r.density = 1; }

    // Clone colors if present
    r.labelXAlign = r.labelXAlign || 0;
    r.labelYAlign = r.labelYAlign || 0;
    r.labelOffset = r.labelOffset || xy(0, 0);
    r.labelShadow = clone(r.labelShadow);
    r.labelColor = clone(r.labelColor);
    r.labelColor = clone(r.labelColor);
    
    if (r.opacity === undefined) {
        r.opacity = 1;
    }
    
    if (r.size === undefined) {
        if (r.sprite) {
            if (r.shape === 'rect') {
                r.size = clone(r.sprite.size);
            } else if (r.shape === 'disk') {
                const x = min_component(r.sprite.size) * r.scale.x;
                r.size = xy(x, x);
                if (r.scale.x !== r.scale.y) {
                    throw new Error('Cannot have different scale factors for x and y on a "disk" shaped entity.');
                }
            }
        } else {
            // no size, no sprite
            r.size = xy(0, 0);
        }
    } else {
        r.size = clone(r.size);
    }

    if (r.pivot === undefined) {
        if (r.sprite) {
            r.pivot = clone(r.sprite.pivot);
        } else {
            r.pivot = xy(0, 0);
        }
    } else {
        r.pivot = clone(r.pivot);
    }

    const child_array = r.child_array ? clone(r.child_array) : [];
    r.child_array = [];
    if (r.orient_with_parent === undefined) { r.orient_with_parent = true; }
    if (r.offset_with_parent === undefined) { r.offset_with_parent = true; }
   
    r.z_in_parent = r.z_in_parent || 0;
    r.pos_in_parent = r.pos_in_parent ? clone(r.pos_in_parent) : xy(0, 0);
    r.angle_in_parent = r.angle_in_parent || 0;
    r.offset_in_parent = r.offset_in_parent ? clone(r.offset_in_parent) : xy(0, 0);
    r.scale_in_parent = r.scale_in_parent ? clone(r.scale_in_parent) : xy(1, 1);

    if (typeof r.scale !== 'object') { $error('The scale of an entity must be an xy().'); }
    if (isNaN(r.angle)) { $error('NaN angle on entity'); }
    if (isNaN(r.z)) { $error('NaN z on entity'); }
    
    // Construct named children
    if (childTable) {
        for (let name in childTable) {
            const child = childTable[name];
            if (! _isEntity(child)) {
                throw new Error('The child named "' + name + '" in the childTable passed to make_entity is not itself an entity');
            }
            
            if (r[name] !== undefined) {
                throw new Error('make_entity() cannot add a child named "' + name +
                                '" because that is already a property of the entity {' + Object.keys(r) + '}');
            }
            r[name] = child;
            if (child.name === 'Anonymous') {
                child.name = name;
            }
            child_array.push(child)
        }
    }

    // Add and update all children
    for (let i = 0; i < child_array.length; ++i) {
        entity_add_child(r, child_array[i]);
    }
    entity_update_children(r);
    
    return r;
}


function entity_add_child(parent, child) {
    if (! child) { return child; }
    
    entity_remove_child(parent, child);
    
    child.parent = parent;
    // Avoid accidental duplicates
    if (parent.child_array.indexOf(child) === -1) {
        parent.child_array.push(child);
    }
    
    return child;
}


function entity_remove_all(parent) {
    for (let i = 0; i < parent.child_array.length; ++i) {
        const child = parent.child_array[i];
        if (parent !== child.parent) {
            throw new Error('Tried to remove a child from the wrong parent')
        }
        remove_values(child.parent.child_array, child);
        if (parent.child_array[i] === child) {
            throw new Error('Tried to remove a child that did not have a pointer back to its parent');
        }
    }
}


function entity_remove_child(parent, child) {
    if (! child) { return child; }
    
    if (child.parent) {
        if (parent !== child.parent) { throw new Error('Tried to remove a child from the wrong parent'); }
        remove_values(parent.child_array, child);
    } else if (parent.child_array.indexOf(child) !== -1) {
        throw new Error('Tried to remove a child that did not have a pointer back to its parent');
    }
    
    child.parent = undefined;
    return child;
}


function transform_es_to_es(entity_from, entity_to, point) {
    return transform_ws_to_es(entity_to, transform_es_to_ws(entity_from, point));
}


function transform_cs_to_ss(cs_point, cs_z) {
    cs_z = cs_z || 0;
    return xy((cs_point.x + (cs_z * $skewXZ)) * $scaleX + $offsetX,
              (cs_point.y + (cs_z * $skewYZ)) * $scaleY + $offsetY);
}


function transform_ss_to_cs(ss_point, ss_z) {
    ss_z = ss_z || 0;
    const cs_z = transform_ss_z_to_cs_z(ss_z);
    return xy((ss_point.x - $offsetX) / $scaleX - cs_z * $skewXZ,
              (ss_point.y - $offsetY) / $scaleY - cs_z * $skewYZ);
}


function transform_ss_to_ws(ss_point, ss_z) {
    ss_z = ss_z || 0;
    const cs_z = transform_ss_z_to_cs_z(ss_z);
    return transform_cs_to_ws(transform_ss_to_cs(ss_point, ss_z), cs_z);
}


function transform_ws_to_ss(ws_point, ws_z) {
    ws_z = ws_z || 0;
    const cs_z = transform_ws_z_to_cs_z(ws_z);
    return transform_cs_to_ss(transform_ws_to_cs(ws_point, ws_z), cs_z);
}


function transform_cs_z_to_ss_z(cs_z) {
    return cs_z * $scaleZ + $offsetZ;
}


function transform_ss_z_to_cs_z(ss_z) {
    return (ss_z - $offsetZ) / $scaleZ;
}


function transform_ws_to_cs(ws_point, ws_z) {
    const cs_z = (ws_z || 0) - $camera.z;
    const mag = _zoom(cs_z);
    const C = $Math.cos($camera.angle) * mag, S = $Math.sin($camera.angle * rotation_sign()) * mag;
    const x = ws_point.x - $camera.x, y = ws_point.y - $camera.y;
    return {x: x * C + y * S, y: y * C - x * S};
}

function transform_cs_to_ws(cs_point, cs_z) {
    const mag = 1 / _zoom(cs_z);
    const C = $Math.cos(-$camera.angle) * mag, S = $Math.sin(-$camera.angle * rotation_sign()) * mag;
    
    const x = cs_point.x - $camera.x, y = cs_point.y - $camera.y;
    return {x: cs_point.x * C + cs_point.y * S + $camera.y,
            y: cs_point.y * C - cs_point.x * S + $camera.x};
}

function transform_ws_to_es(entity, coord) {
    if (! entity || entity.pos === undefined |! coord || coord.x === undefined) { throw new Error("Requires both an entity and a coordinate"); }
    return transform_to(entity.pos, entity.angle, entity.scale, coord);
}


function transform_es_to_ws(entity, coord) {
    if (! coord || coord.x === undefined) { throw new Error("transform_es_to_ws() requires both an entity and a coordinate"); }
    return transform_from(entity.pos, entity.angle, entity.scale, coord);
}


function transform_to_child(child, pos) {
    const a = child.parent.angle - child.angle;
    const c = $Math.cos(a);
    const s = $Math.sin(a);
    const x = pos.x - child.pos_in_parent.x;
    const y = pos.y - child.pos_in_parent.y;
    
    return xy( c * x + s * y,
              -s * x + c * y)
}

function transform_to_parent(child, pos) {
    const a = child.angle - child.parent.angle;
    const c = $Math.cos(a);
    const s = $Math.sin(a);
    return xy( c * pos.x + s * pos.y + child.pos_in_parent.x,
              -s * pos.x + c * pos.y + child.pos_in_parent.y)
}


// Recursively update all properties of the children
function entity_update_children(parent) {
    if (parent === undefined || parent.pos === undefined) {
        throw new Error('entity_update_children requires an entity argument')
    }

    if (typeof parent.scale !== 'object') { $error('The scale of the parent entity must be an xy().'); }
    if (isNaN(parent.angle)) { $error('NaN angle on parent entity'); }
    if (isNaN(parent.z)) { $error('NaN z on parent entity'); }
    
    const N = parent.child_array.length;
    const rotSign = $Math.sign(parent.scale.x * parent.scale.y);
    const a = parent.angle * rotation_sign() * rotSign;
    const c = $Math.cos(a), s = $Math.sin(a);
    
    for (let i = 0; i < N; ++i) {
        const child = parent.child_array[i];

        if (child.orient_with_parent) {
            child.scale.x = parent.scale.x * child.scale_in_parent.x;
            child.scale.y = parent.scale.y * child.scale_in_parent.y;
            child.angle   = parent.angle + child.angle_in_parent * rotSign;
        }
       
        child.pos.x = (c * child.pos_in_parent.x - s * child.pos_in_parent.y) * parent.scale.x + parent.pos.x;
        child.pos.y = (s * child.pos_in_parent.x + c * child.pos_in_parent.y) * parent.scale.y + parent.pos.y;
        child.z = parent.z + child.z_in_parent;

        if (child.offset_with_parent) {
            child.offset.x = (c * child.offset_in_parent.x - s * child.offset_in_parent.y) * parent.scale.x + parent.offset.x;
            child.offset.y = (s * child.offset_in_parent.x + c * child.offset_in_parent.y) * parent.scale.y + parent.offset.y;
        }
      
        entity_update_children(child);
    }
}


function entity_simulate(entity, dt) {
    // Assume this computation takes 0.01 ms. We have no way to time it
    // properly, but this at least gives some feedback in the profiler
    // if it is being called continuously.
    _physicsTimeTotal += 0.01;
    
    if (dt === undefined) { dt = 1; }
    if (entity.density === Infinity) { return; }
    
    const mass = entity_mass(entity);
    if (mass <= 0) {
        $error('Mass must be positive in entity_simulate()');
    }
    const imass = 1 / mass;
    const iinertia = 1 / entity_inertia(entity, mass);
    const acc = entity.acc, vel = entity.vel, pos = entity.pos;

    // Overwrite
    const accX = entity.force.x * imass;
    const accY = entity.force.y * imass;

    // Drag should fall off with the time step to remain constant
    // as the time step varies (in the absence of acceleration)
    const k = $Math.pow(1 - entity.drag, dt);
    
    // Integrate
    vel.x *= k;
    vel.y *= k;
    vel.x += accX * dt;
    vel.y += accY * dt;

    pos.x += vel.x * dt;
    pos.y += vel.y * dt;

    const twist = entity.torque * iinertia;

    // Integrate
    entity.spin  *= k;
    entity.spin  += twist * dt;
    entity.angle += entity.spin * dt

    // Zero for next step
    entity.torque = 0;
    entity.force.x = entity.force.y = 0;

    entity_update_children(entity);
}


function entity_apply_force(entity, worldForce, worldPos) {
    worldPos = worldPos || entity.pos;
    entity.force.x += worldForce.x;
    entity.force.y += worldForce.y;
    const offsetX = worldPos.x - entity.pos.x;
    const offsetY = worldPos.y - entity.pos.y;
    entity.torque += -rotation_sign() * (offsetX * worldForce.y - offsetY * worldForce.x);
}


function entity_apply_impulse(entity, worldImpulse, worldPos) {
    worldPos = worldPos || entity.pos;
    const invMass = 1 / entity_mass(entity);
    entity.vel.x += worldImpulse.x * invMass;
    entity.vel.y += worldImpulse.y * invMass;

    const inertia = entity_inertia(entity);
    const offsetX = worldPos.x - entity.pos.x;
    const offsetY = worldPos.y - entity.pos.y;

    entity.spin += -rotation_sign() * (offsetX * worldImpulse.y - offsetY * worldImpulse.x) / inertia;
}


         
function entity_move(entity, pos, angle) {
    if (pos !== undefined) {
        entity.vel.x = pos.x - entity.pos.x;
        entity.vel.y = pos.y - entity.pos.y;
        entity.pos.x = pos.x;
        entity.pos.y = pos.y;
    }
      
    if (angle !== undefined) {
        // Rotate the short way
        entity.spin = loop(angle - entity.angle, -PI, $Math.PI);
        entity.angle = angle;
    }
}


/*************************************************************************************/
//
// Physics functions

function make_contact_group() {
    // Matter.js uses negative numbers for non-colliding
    // groups, so we negate them everywhere to make it more
    // intuitive for the user.
    return -$Physics.Body.nextGroup(true);
}


// Density scale multiplier used to map to the range where
// matter.js constants are tuned for. Using a power of 2 makes
// the round trip between matter and quadplay more stable.
// This is about 0.001, which is the default density in matter.js.
var _PHYSICS_MASS_SCALE     = $Math.pow(2,-10);
var _PHYSICS_MASS_INV_SCALE = $Math.pow(2,10);
var _physicsContextIndex = 0;

function $physicsUpdateContact(physics, contact, pair) {
    const activeContacts = pair.activeContacts;
    
    contact.normal.x = pair.collision.normal.x;
    contact.normal.y = pair.collision.normal.y;
    contact.point0.x = activeContacts[0].vertex.x;
    contact.point0.y = activeContacts[0].vertex.y;

    // For debugging contacts
    // $console.log(" update: ", contact.point0.x);
    
    if (activeContacts.length > 1) {
        if (! contact.point1) { contact.point1 = {}; }
        contact.point1.x = activeContacts[1].vertex.x;
        contact.point1.y = activeContacts[1].vertex.y;
    } else {
        contact.point1 = undefined;
    }
    contact.depth = pair.collision.depth;
    contact._lastRealContactFrame = physics._frame;
}


function make_physics(options) {
    const engine = $Physics.Engine.create();
    const physics = Object.seal({
        _name:                 "physics" + (_physicsContextIndex++),
        _engine:               engine,
        _contactCallbackArray: [],
        _newContactArray:      [], // for firing callbacks and visualization. wiped every frame

        _frame:                0,
        
        // _brokenContactQueue[0] is an array of contacts that broke _brokenContactQueue.length - 1
        // frames ago (but may have been reestablished). Add empty arrays to this queue to maintain
        // old contacts for more frames so that bouncing/sliding contact feels more robust.
        _brokenContactQueue:   [[], [], [], []],
        
        // Maps bodies to maps of bodies to contacts.
        _entityContactMap:     new Map(), 

        // All entities in this physics context
        _entityArray:          []})
    
    options = options || {}
   
    if (options.gravity) {
        engine.world.gravity.x = options.gravity.x;
        engine.world.gravity.y = options.gravity.y;
    } else {
        engine.world.gravity.y = -up_y();
    }
      
    engine.world.gravity.scale = 0.001; // default 0.001
    engine.enableSleeping = (options.allowSleeping !== false);

    // Higher improves compression under large stacks or
    // small objects.  Too high causes instability.
    engine.positionIterations   = 10; // default 6

    // Higher improves processing of fast objects and thin walls.
    // Too high causes instability.
    engine.velocityIterations   = 12; // default 4
    engine.constraintIterations = 4;  // default 2. Higher lets more chained constraints propagate.

    // Extra constraints enforced by quadplay
    engine.customAttachments = [];
        
    // Allows slowmo, etc.
    // engine.timing.timeScale = 1

    $Physics.Events.on(engine, 'collisionStart', function (event) {
        const pairs = event.pairs;
        for (let i = 0; i < pairs.length; ++i) {
            const pair = pairs[i];
            const activeContacts = pair.activeContacts;

            // Create the map entries if they do not already exist
            let mapA = physics._entityContactMap.get(pair.bodyA);
            if (mapA === undefined) { physics._entityContactMap.set(pair.bodyA, mapA = new Map()); }

            let mapB = physics._entityContactMap.get(pair.bodyB);
            if (mapB === undefined) { physics._entityContactMap.set(pair.bodyB, mapB = new Map()); }
            
            let contact = mapA.get(pair.bodyB);
            
            if (! contact) {
                // This new contact will not appear in the
                // collisionActive event for one frame, so update
                // the properties right now
                contact = {
                    entityA: pair.bodyA.entity,
                    entityB: pair.bodyB.entity,
                    normal:  {x: pair.collision.normal.x, y: pair.collision.normal.y},
                    point0:  {x: activeContacts[0].vertex.x, y: activeContacts[0].vertex.y},
                    point1:  (activeContacts.length === 1) ? {} : {x: activeContacts[1].vertex.x, y: activeContacts[1].vertex.y},
                    depth:   pair.collision.depth
                }

                // For use in collision callbacks
                physics._newContactArray.push(contact);

                // For use in queries
                mapA.set(pair.bodyB, contact);
                mapB.set(pair.bodyA, contact);

                // for debugging collisions
                //$console.log(physics._frame + ' +begin ' + contact.entityA.name + " & " + contact.entityB.name);
            } else {
                $console.assert(mapB.get(pair.bodyA), 'Internal error: Mismatched contact pair in physics simulation');
                // ...else: this contact already exists and is in the maps because it was recently active.
                // it is currently scheduled in the broken contact queue. Update the data; the Active
                // event will not be called by Matter.js

                // for debugging collisions
                //$console.log(physics._frame + ' resume ' + contact.entityA.name + " & " + contact.entityB.name);
                $physicsUpdateContact(physics, contact, pair);
            }
            
            contact._lastRealContactFrame = physics._frame;                
        }
    });

    $Physics.Events.on(engine, 'collisionActive', function (event) {
        const pairs = event.pairs;
        for (let i = 0; i < pairs.length; ++i) {
            const pair = pairs[i];

            // We could fetch from A and then B or B and then A. Both give the same
            // result.
            const contact = physics._entityContactMap.get(pair.bodyA).get(pair.bodyB);

            if (! contact) {
                // Something went wrong and matter.js has just updated us about a
                // contact that is no longer active. Ignore it.
                continue;
            }
            
            // for debugging collisions
            // $console.log(physics._frame + ' active ' + contact.entityA.name + " & " + contact.entityB.name);
            $physicsUpdateContact(physics, contact, pair);
        }
    });

    $Physics.Events.on(engine, 'collisionEnd', function (event) {
        // Schedule collisions for removal
        const pairs = event.pairs;
        const removeArray = last_value(physics._brokenContactQueue);
        for (let i = 0; i < pairs.length; ++i) {
            const pair = pairs[i];

            if (pair.isActive) {
                // Active contacts should never end
                continue;
            }
            
            // Find the contact (it may have already been removed)
            const contact = physics._entityContactMap.get(pair.bodyA).get(pair.bodyB);

            // If not already removed
            if (contact) {
                // A potential improvement to add here later: if
                // moving with high velocity away from the contact,
                // then maybe end the contact immediately

                // for debugging collisions
                //$console.log(physics._frame + ' (brk)  ' + contact.entityA.name + " & " + contact.entityB.name);
                
                // Schedule the contact for removal. It can gain a reprieve if is updated
                // before it hits the front of the queue.
                removeArray.push(contact);
            }
        }
    });
        
    return physics;
}


function physics_add_entity(physics, entity) {
    if (! physics) { $error("physics context cannot be nil"); }
    if (! physics._engine) { $error("First argument to physics_add_entity() must be a physics context."); }
    if (entity.$body) { $error("This entity is already in a physics context"); }
    if (entity.density <= 0) { $error("The entity in physics_add_entity() must have nonzero density"); }

    push(physics._entityArray, entity);
    const engine = physics._engine;
   
    const params = {isStatic: entity.density === Infinity};

    switch (entity.shape) {
    case "rect":
        entity.$body = $Physics.Bodies.rectangle(entity.pos.x, entity.pos.y, entity.size.x * entity.scale.x, entity.size.y * entity.scale.y, params);
        break;
        
    case "disk":
        entity.$body = $Physics.Bodies.circle(entity.pos.x, entity.pos.y, 0.5 * entity.size.x * entity.scale.x, params);
        break;

    default:
        throw new Error('Unsupported entity shape for physics_add_entity(): "' + entity.shape + '"');
    }

    entity.$body.collisionFilter.group = -entity.contact_group;
    entity.$body.entity = entity;
    entity.$body.slop = 0.075; // 0.05 is the default. Increase to make large object stacks more stable.
    entity._attachmentArray = [];
    $Physics.World.add(engine.world, entity.$body);

    $bodyUpdateFromEntity(entity.$body);

    return entity;
}


function physics_remove_all(physics) {
    // Remove all (removing mutates the
    // array, so we have to clone it first!)
    const originalArray = clone(physics._entityArray);
    for (let a = 0; a < originalArray.length; ++a) {
        physics_remove_entity(physics, originalArray[a]);
    }
    
    // Shouldn't be needed, but make sure everything is really gone
    $Physics.Composite.clear(physics._engine.world, false, true);
}


function physics_remove_entity(physics, entity) {
    // Remove all attachments (removing mutates the
    // array, so we have to clone it first!)
    const originalArray = clone(entity._attachmentArray);
    for (let a = 0; a < originalArray.length; ++a) {
        physics_detach(physics, originalArray[a]);
    }

    // Remove all contacts that we are maintaining.  It is OK to have
    // contacts in the broken removal queue because that ignores the
    // case where the bodies are no longer present

    // New contacts:
    const newContactArray = physics._newContactArray;
    for (let c = 0; c < newContactArray.length; ++c) {
        const contact = newContactArray[c];
        if (contact.entityA === entity || contact.entityB === entity) {
            // Fast remove and shrink
            newContactArray[c] = last_value(newContactArray);
            --newContactArray.length;
            --c;
        }
    }

    // Maintained contacts:
    const body = entity.$body;
    const map = physics._entityContactMap.get(body);
    if (map) {
        for (const otherBody of map.keys()) {
            // Remove the reverse pointers
            const otherMap = physics._entityContactMap.get(otherBody);
            otherMap.delete(body);
        }
        // Remove the entire map for body, so that
        // body can be garbage collected
        physics._entityContactMap.delete(body);
    }
    
    $Physics.World.remove(physics._engine.world, body, true);
    fast_remove_value(physics._entityArray, entity);
    entity.$body = undefined;
    entity._attachmentArray = undefined;
}

   
// internal   
function _entityUpdateFromBody(entity) {
    const S = rotation_sign();
    
    const body     = entity.$body;
    entity.pos.x   = body.position.x;
    entity.pos.y   = body.position.y;
    entity.vel.x   = body.velocity.x;
    entity.vel.y   = body.velocity.y;
    entity.force.x = body.force.x * _PHYSICS_MASS_INV_SCALE;
    entity.force.y = body.force.y * _PHYSICS_MASS_INV_SCALE;
    entity.spin    = body.angularVelocity * S;
    entity.angle   = body.angle * S;
    entity.torque  = body.torque * _PHYSICS_MASS_INV_SCALE * S;

    if (entity.physics_sleep_state === 'vigilant') {
        if (body.isSleeping) { $Physics.Sleeping.set(body, false); }
    } else {
        entity.physics_sleep_state = body.isSleeping ? 'sleeping' : 'awake';
    }
    /*
    // The physics update would never change these:
    entity.density = body.density
    entity.restitution    = body.restitution
    entity.friction       = body.friction
    entity.drag           = body.frictionAir
    entity.stiction_factor = body.frictionStatic
    */
}


// internal   
function $bodyUpdateFromEntity(body) {
    const entity  = body.entity;

    // For numerical stability, do not set properties unless they appear to have changed
    // on the quadplay side

    const changeThreshold = 0.00001;
    let awake = entity.physics_sleep_state === 'vigilant' || entity.physics_sleep_state === 'awake';
    const S = rotation_sign();

    // Wake up on changes
    if ($Math.abs(body.position.x - entity.pos.x) > changeThreshold ||
        $Math.abs(body.position.y - entity.pos.y) > changeThreshold) {
        $Physics.Body.setPosition(body, entity.pos)
        awake = true;
    }
    
    // Must set velocity after position, because matter.js is a vertlet integrator
    if ($Math.abs(body.velocity.x - entity.vel.x) > changeThreshold ||
        $Math.abs(body.velocity.y - entity.vel.y) > changeThreshold) {
        // Note: a future Matter.js API will change body.velocity and require using body.getVelocity
        $Physics.Body.setVelocity(body, entity.vel);
        awake = true;
    }

    if ($Math.abs(body.angularVelocity - entity.spin * S) > changeThreshold) {
        $Physics.Body.setAngularVelocity(body, entity.spin * S);
        awake = true;
    }

    if ($Math.abs(body.angle - entity.angle * S) > changeThreshold) {
        $Physics.Body.setAngle(body, entity.angle * S);
        awake = true;
    }

    if (! body.isStatic) {
        const d = entity.density * _PHYSICS_MASS_SCALE;
        if ($Math.abs(body.density - d) > changeThreshold) {
            $Physics.Body.setDensity(body, d);
            awake = true;
        }
    }

    body.collisionFilter.group = -entity.contact_group;
    body.collisionFilter.mask  = entity.contact_hit_mask;
    body.collisionFilter.category = entity.contact_category_mask;
         
    body.force.x = entity.force.x * _PHYSICS_MASS_SCALE;
    body.force.y = entity.force.y * _PHYSICS_MASS_SCALE;
    body.torque  = entity.torque * S * _PHYSICS_MASS_SCALE;

    body.friction       = entity.friction;
    body.frictionStatic = entity.stiction_factor;
    body.frictionAir    = entity.drag;
    body.restitution    = entity.restitution;

    body.isSensor       = entity.is_sensor;
    
    // The Matter.js API does not notice if an object woke up due to velocity, only
    // due to forces.
    awake = awake || $Math.max($Math.abs(body.angularVelocity), $Math.abs(body.velocity.x), $Math.abs(body.velocity.y)) > 0.01;
    // $Math.max($Math.abs(body.torque), $Math.abs(body.force.x), $Math.abs(body.force.y)) > 1e-9 ||
    
    // Change wake state if needed
    if (body.isSleeping === awake) {
        $Physics.Sleeping.set(body, ! awake);
    }
}

      
function physics_simulate(physics, stepFrames) {
    const startTime = performance.now();
          
    if (stepFrames === undefined) { stepFrames = 1; }
    const engine = physics._engine;

    // $console.log('--------------- timestamp: ' + physics.timing.timestamp);
    
    physics._newContactArray = [];

    const bodies = $Physics.Composite.allBodies(engine.world);
    for (let b = 0; b < bodies.length; ++b) {
        const body = bodies[b];
        // Not all bodies have entities; some are created
        // internally by the physics system.
        if (body.entity) { $bodyUpdateFromEntity(body); }
    }
      
    $Physics.Engine.update(engine, stepFrames * 1000 / 60);

    // Enforce the quadplay special constraints. This would be better
    // implemented by injecting the new constraint solver directly
    // into $Physics.Constraint.solveAll, so that it happens within
    // the solver during the main iterations.
    if (engine.customAttachments.length > 0) {
        for (let it = 0; it < 2; ++it) {
            for (let a = 0; a < engine.customAttachments.length; ++a) {
                const attachment = engine.customAttachments[a];
                if (attachment.type === 'gyro') {
                    const body = attachment.entityB.$body;
                    const angle = attachment.angle;
                    $Physics.Body.setAngularVelocity(body, 0);
                    $Physics.Body.setAngle(body, angle);
                }
            }
            
            // Force one extra iteration of constraint solving to reconcile
            // what we just did above, so that attached parts are not lagged
            if (it === 0) {
                let allConstraints = $Physics.Composite.allConstraints(engine.world);
                
                $Physics.Constraint.preSolveAll(bodies);
                for (let i = 0; i < engine.constraintIterations; ++i) {
                    $Physics.Constraint.solveAll(allConstraints, engine.timing.timeScale);
                }
                $Physics.Constraint.postSolveAll(bodies);
            }
        }
    }
   
    for (let b = 0; b < bodies.length; ++b) {
        const body = bodies[b];
        // Some bodies are created internally within the physics system
        // and have no corresponding entity.
        if (body.entity) { _entityUpdateFromBody(body.entity); }
    }

    // Remove old contacts that were never reestablished

    // advance the queue
    const maybeBrokenContactList = physics._brokenContactQueue.shift(1);
    physics._brokenContactQueue.push([]);
    
    for (let c = 0; c < maybeBrokenContactList.length; ++c) {
        const contact = maybeBrokenContactList[c];
        // See if contact was reestablished within the lifetime of the queue:
        if (contact._lastRealContactFrame <= physics._frame - physics._brokenContactQueue.length) {
            // Contact was not reestablished in time, so remove it
            const bodyA = contact.entityA.$body, bodyB = contact.entityB.$body;

            // For debugging collisions:
            // $console.log(physics._frame + ' - end  ' + contact.entityA.name + " & " + contact.entityB.name + '\n\n');

            // Remove the contact both ways
            const mapA = physics._entityContactMap.get(bodyA);
            if (mapA) { mapA.delete(bodyB); }
            
            const mapB = physics._entityContactMap.get(bodyB);
            if (mapB) { mapB.delete(bodyA); }
        }
    }

    if ($showPhysicsEnabled) {
        draw_physics(physics);
    }

    // Fire event handlers for new contacts
    for (const event of physics.$contactCallbackArray.values()) {
        for (const contact of physics._newContactArray.values()) {

            if ((((contact.entityA.contact_category_mask & event.contact_mask) |
                  (contact.entityB.contact_category_mask & event.contact_mask)) !== 0) &&
                (contact.depth >= event.min_depth) && (contact.depth <= event.max_depth) &&
                ((event.sensors === 'include') ||
                 ((event.sensors === 'only') && (contact.entityA.is_sensor || contact.entityB.is_sensor)) ||
                 ((event.sensors === 'exclude') && ! (contact.entityA.is_sensor || contact.entityB.is_sensor)))) {

                event.callback({
                    entityA: contact.entityA,
                    entityB: contact.entityB,
                    normal:  xy(contact.normal),
                    point0:  xy(contact.point0),
                    point1:  clone(contact.point1),

                });
            }
        } // event
    } // contact

    ++physics._frame;

    const endTime = performance.now();
    _physicsTimeTotal += endTime - startTime;
}


function physics_add_contact_callback(physics, callback, min_depth, max_depth, contact_mask, sensors) {
    if (contact_mask === 0) { throw new Error('A contact callback with contact_mask = 0 will never run.'); }

    physics.$contactCallbackArray.push({
        callback:      callback,
        min_depth:     min_depth || 0,
        max_depth:     (max_depth !== undefined) ? max_depth : Infinity,
        contact_mask:  (contact_mask !== undefined) ? contact_mask : 0xffffffff,
        sensors:       sensors || 'exclude'
    });
}


function physics_entity_has_contacts(physics, entity, region, normal, mask, sensors) {
    return $physics_entity_contacts(physics, entity, region, normal, mask, sensors, true);
}

function physics_entity_contacts(physics, entity, region, normal, mask, sensors) {
    return $physics_entity_contacts(physics, entity, region, normal, mask, sensors, false);
}

function $physics_entity_contacts(physics, entity, region, normal, mask, sensors, earlyOut) {
    if (mask === undefined) { mask = 0xffffffff; }
    if (mask === 0) { throw new Error('physics_entity_contacts() with mask = 0 will never return anything.'); }
    if (! entity) { throw new Error('physics_entity_contacts() must have a non-nil entity'); }

    const engine = physics._engine;
    sensors = sensors || 'exclude';

    // Look at all contacts for this entity
    const body = entity.$body;
    const map = physics._entityContactMap.get(body);
    const result = earlyOut ? false : [];

    if (map === undefined) {
        // No contacts
        return result;
    }
    
    // Create a test shape with all of the required properties to avoid allocation by the
    // repeated overlaps() calls
    const testPointShape = {shape: 'disk', angle: 0, size: xy(0, 0), scale: xy(1, 1), pos: xy(0, 0)};
    const testPoint = testPointShape.pos;

    const Rx = $Math.cos(entity.angle) / entity.scale.x, Ry = $Math.sin(entity.angle) * rotation_sign() / entity.scale.y;
    const Tx = entity.pos.x, Ty = entity.pos.y;

    // Avoid having overlaps() perform the cleanup test many times
    if (region) { region = _cleanupRegion(region); }
    if (normal) { normal = direction(normal); }
    
    // cosine of 75 degrees
    const angleThreshold = $Math.cos($Math.PI * 80 / 180);
    
    for (const contact of map.values()) {
        const isA = contact.entityA === entity;
        const isB = contact.entityB === entity;
        const other = isA ? contact.entityB : contact.entityA; 

        // Are we in the right category?
        if ((other.contact_category_mask & mask) === 0) {
            // $console.log("Mask rejection");
            continue;
        }

        if (((sensors === 'exclude') && other.is_sensor) ||
            ((sensors === 'only') && ! other.is_sensor)) {
            // $console.log("Sensor rejection");
            continue;
        }
 

        if (region) {
            let x, y;
            if (contact.point1) {
                x = (contact.point0.x + contact.point1.x) * 0.5;
                y = (contact.point0.y + contact.point1.y) * 0.5;
            } else {
                x = contact.point0.x; y = contact.point0.y;
            }

            x -= Tx; y -= Ty;
            
            // Transform the average point to the reference frame of
            // the region.  This will make testing faster for the
            // common case of an axis-aligned box.
            testPoint.x = Rx * x + Ry * y;
            testPoint.y = Rx * y - Ry * x;
            
            // Is the average contact point within the region?
            if (! overlaps(region, testPointShape, false)) {
                // $console.log("Region rejection");
                continue;
            }
        }

        if (normal) {
            // Collision normal
            let Cx = contact.normal.x, Cy = contact.normal.y;
            if (isB) { Cx = -Cx; Cy = -Cy; }
            if (Cx * normal.x + Cy * normal.y < angleThreshold) {
                // $console.log("Angle rejection");
                continue;
            }
        }

        if (earlyOut) { return true; }
        
        // Push a copy of the contact. Do not deep clone,
        // as that would copy the entitys as well.
        $console.assert(contact.normal && contact.point0);
        const copy = {
            entityA: contact.entityA,
            entityB: contact.entityB,
            normal:  xy(contact.normal),
            point0:  xy(contact.point0),
            depth:   contact.depth
        };
        if (contact.point1) { copy.point1 = {x:contact.point1.x, y:contact.point1.y}; }
        result.push(copy);
    }

    return result;
}


function physics_detach(physics, attachment) {
    // Remove from the entitys
    fast_remove_value(attachment.entityB._attachmentArray, attachment);
    if (attachment.entityA) { fast_remove_value(attachment.entityA._attachmentArray, attachment); }

    // Decrement and remove reference-counted no-collision elements
    const mapA = attachment.entityA.$body.collisionFilter.excludedBodies;
    if (mapA) {
        const count = map.get(attachment.entityB.$body);
        if (count !== undefined) {
            if (count > 1) {
                mapA.set(attachment.entityB.$body, count - 1);
            } else {
                // Remove the no-collision condition
                mapA.delete(attachment.entityB.$body);
            }
        }
    }

    const mapB = attachment.entityB.$body.collisionFilter.excludedBodies;
    if (mapB) {
        const count = map.get(attachment.entityA.$body);
        if (count !== undefined) {
            if (count > 1) {
                mapB.set(attachment.entityA.$body, count - 1);
            } else {
                // Remove the no-collision condition
                mapB.delete(attachment.entityA.$body);
            }
        }
    }

    // Remove the composite, which will destroy all of the Matter.js elements
    // that comprise this constraint
    $Physics.Composite.remove(physics._engine.world, attachment._composite, true);
}


function physics_attach(physics, type, param) {
    if (param.entityA && ! param.entityA.$body) { throw new Error("entityA has not been added to the physics context"); }
    if (! param.entityB) { throw new Error("entityB must not be nil"); }
    if (! param.entityB.$body) { throw new Error("entityB has not been added to the physics context"); }
    if (param.entityB.density === Infinity) { throw new Error("entityB must have finite density"); }

    physics = physics._engine;

    // Object that will be returned
    const attachment = {
        type:    type,
        entityA: param.entityA,
        entityB: param.entityB
    };

    if (type === 'weld') {
        // Satisfy the initial angle constraint. Do this before computing
        // positions
        if (param.length !== undefined) { throw new Error('Weld attachments do not accept a length parameter'); }
        if (param.angle !== undefined) {
            param.entityB.angle = param.angle + (param.entityA ? param.entityA.angle : 0);
            $bodyUpdateFromEntity(attachment.entityB.$body);
        }        
    }
    
    // Create options for constructing a matter.js constraint.
    // matter.js wants the points relative to the centers of the
    // bodies, but not rotated by the bodies
    const options = {
        bodyB:  param.entityB.$body,
        pointB: _objectSub(transform_es_to_ws(param.entityB, param.pointB || xy(0, 0)), param.entityB.pos)
    };

    if (type === 'weld') {
        // Use this hack to stiffen; setting angularStiffness very high
        // is likely to affect torque in strange ways, so don't go too high
        options.angularStiffness = 0.1;
    }
    
    /////////////////////////////////////////////////////////////////////
    // Are collisions allowed between these objects?
    
    let collide = find(["rope", "string", "rod"], type) !== undefined;
    if (param.collide !== undefined) { collide = param.collide; }
    
    // Always enable collisions with the world, since they won't happen
    // and it is free to do so
    if (! param.entityA) { collide = true; }

    if (param.entityA &&
        (param.entityA.$body.collisionFilter.group < 0) &&
        (param.entityA.$body.collisionFilter.group === param.entityB.$body.collisionFilter.group)) {
        // These are in the same collision group; they couldn't collide anyway, so there is no
        // need to explicitly prevent collisions
        collide = true;
    }

    if (param.entityA &&
        ((param.entityB.$body.collisionFilter.mask & param.entityA.$body.collisionFilter.category) === 0) &&
        ((param.entityA.$body.collisionFilter.mask & param.entityB.$body.collisionFilter.category) === 0)) {
        // These could not collide with each other because they have no overlap in their masks
        collide = true;
    }
    
    // Update the entity's collision filters. See console/matter-extensions.js
    if (! collide) {
        // Reference counting on the excludedBodies maps
        param.entityA.$body.collisionFilter.body = param.entityA.$body;
        if (! param.entityA.$body.collisionFilter.excludedBodies) { param.entityA.$body.collisionFilter.excludedBodies = new WeakMap(); }
        param.entityA.$body.collisionFilter.excludedBodies.set(param.entityB.$body, (param.entityA.$body.collisionFilter.excludedBodies.get(param.entityB.$body) || 0) + 1);

        param.entityB.$body.collisionFilter.body = param.entityB.$body;
        if (! param.entityB.$body.collisionFilter.excludedBodies) { param.entityB.$body.collisionFilter.excludedBodies = new WeakMap(); }        
        param.entityB.$body.collisionFilter.excludedBodies.set(param.entityA.$body, (param.entityB.$body.collisionFilter.excludedBodies.get(param.entityA.$body) || 0) + 1);
    }

    /////////////////////////////////////////////////////////////////////

    // World-space point
    const B = _objectAdd(attachment.entityB.pos, options.pointB);
    let A;
    if (param.entityA) {
        options.bodyA = param.entityA.$body;
        if (param.pointA) {
            A = transform_es_to_ws(param.entityA, param.pointA);
            options.pointA = _objectSub(A, param.entityA.pos);
        } else {
            A = param.entityA.pos;
        }
    } else if (! param.pointA) {
        // Default to the same point on the world
        options.pointA = B;
        A = B;
    } else {
        // no entityA but there is a pointA
        A = options.pointA = param.pointA;
    }

    const delta = _objectSub(B, A);
    const len = magnitude(delta);
   
    switch (type) {
    case 'gyro':
        {
            attachment.angle = param.angle || 0;
            // We *could* make this work against an arbitrary entity, but for now
            // constrain to the world for simplicity
            if (param.entityA) { throw new Error('A "gyro" attachment requires that entityA = nil'); }
            push(physics.customAttachments, attachment);
        }
        break;
        
    case 'spring':
    case 'rod':
    case 'weld':
        {
            if (type === 'spring') {
                options.damping = (param.damping !== undefined) ? param.damping : 0.002;
                options.stiffness = (param.stiffness !== undefined) ? param.stiffness : 0.005;
            } else {
                // For stability, don't make the joints too stiff
                options.damping   = 0.2;
                options.stiffness = 0.95;
            }
            
            attachment.damping = options.damping;
            attachment.stiffness = options.stiffness;
            if ((param.length === undefined) && (type !== 'weld')) {
                // Default to the current positions for springs and rods
                attachment.length = len;
            } else {
                attachment.length = (type === 'weld') ? 0 : param.length;

                // Amount positions need to change by to satisfy the
                // rest length initially. matter.js uses the current
                // positions of the bodies to determine the rest length
                const change = attachment.length - len;
                
                if ($Math.abs(change) > 1e-9) {
                    // Teleport entityB to satisfy the rest length
                    if (magnitude(delta) <= 1e-9) {
                        // If A and B are on top of each other and there's
                        // a nonzero rest length, arbitrarily choose to
                        // move along the x-axis
                        attachment.entityB.pos.x += change;
                    } else{
                        attachment.entityB.pos.x += delta.x * change / len;
                        attachment.entityB.pos.y += delta.y * change / len;
                    }
                    $bodyUpdateFromEntity(attachment.entityB.$body);
                }
            }

            attachment._composite = $Physics.Composite.create();
            const constraint = $Physics.Constraint.create(options);
            constraint.attachment = attachment;
            $Physics.Composite.add(attachment._composite, constraint);
            
            if (attachment.type === 'weld') {
                if (! param.entityA) { throw new Error('Entities may not be welded to the world.'); }

                // Connect back with double-constraints to go through
                // an intermediate "weld body" object.  The weld body
                // must be centered at the constraint point so that
                // its rotation is ignored.  Make the weld body a disk
                // so that rotation has no net effect on shape (and
                // thus moment of inertia) as well as it spins.
                //
                // Only one weld body is required to prevent roation,
                // but that body must be away from the weld center and
                // thus will create asymmetry. A full circle of pins
                // would be the most symmetric, but is expensive, so
                // we add a small number of weld bodies.
                //
                // Each fake body must have some mass to it or the
                // constraints won't have much effect. Unfortunately,
                // this changes the net mass and moment of inertia of
                // the compound shape, which is why parenting is a
                // better solution than welding.

                // Higher gives more rigidity but also affects moment
                // of inertia more
                const offsetRadius = 16;
                const numPins = 4;
                const weldPinRadius = 3;

                // Higher gives more rigidity but also affects mass
                // and moment of inertia more;
                const weldDensity = _PHYSICS_MASS_SCALE * (entity_mass(param.entityA) + entity_mass(param.entityB)) / 3500;

                // In world space
                const weldPos = _objectAdd(options.pointB, param.entityB.$body.position);
                const weldDamping = 0.2;
                
                // Iterate around the circle
                for (let p = 0; p < numPins; ++p) {
                    const offsetAngle = 2 * $Math.PI * p / numPins;
                    const offset = xy(offsetRadius * $Math.cos(offsetAngle), offsetRadius * $Math.sin(offsetAngle));

                    const weldBody = $Physics.Bodies.circle(weldPos.x + offset.x, weldPos.y + offset.y, weldPinRadius, {density: weldDensity});
                    // Prevent collisions with everything
                    weldBody.collisionFilter.mask = weldBody.collisionFilter.category = 0;
                    // Add the invisible weldBody
                    $Physics.Composite.add(attachment._composite, weldBody);

                    // B -> Weld
                    $Physics.Composite.add(attachment._composite, $Physics.Constraint.create({
                        bodyA:     param.entityB.$body,
                        pointA:    _objectSub(weldBody.position, param.entityB.$body.position),
                        bodyB:     weldBody,
                        damping:   weldDamping,
                        stiffness: 0.9
                    }));
                    
                    // Weld -> A
                    $Physics.Composite.add(attachment._composite, $Physics.Constraint.create({
                        bodyA:     weldBody,
                        bodyB:     param.entityA.$body, 
                        pointB:    _objectSub(weldBody.position, param.entityA.$body.position),
                        damping:   weldDamping,
                        stiffness: 0.9
                    }));

                } // for each weld pin
            }
            
        }
        break;
      
    case "pin":
        {
            if ($Math.abs(len) > 1e-9) {
                attachment.entityB.pos.x -= delta.x;
                attachment.entityB.pos.y -= delta.y;
                $bodyUpdateFromEntity(attachment.entityB.$body);
            }

            // matter.js uses the current positions of the bodies to determine the rest length
            attachment._composite = $Physics.Composite.create();
            const constraint = $Physics.Constraint.create(options);
            constraint.attachment = attachment;
            $Physics.Composite.add(attachment._composite, constraint);
        }
        break;
        
    default:
        throw new Error('Attachment type "' + type + '" not supported');
    }

    
    if (attachment._composite) {
        // Push the attachment's composite into the world
        $Physics.Composite.add(physics.world, attachment._composite);
    }

    if (attachment.entityA) { push(attachment.entityA._attachmentArray, attachment); }
    push(attachment.entityB._attachmentArray, attachment);
    
    return Object.freeze(attachment);
}
      
      
function draw_physics(physics) {
    const showSecrets = false;
    const awakeColor   = rgb(0.10, 1.0, 0.5);
    const sleepColor   = rgb(0.05, 0.6, 0.3);
    const staticColor  = gray(0.8);
    const contactColor = rgb(1, 0.93, 0);
    const sensorColor      = rgb(0.3, 0.7, 1);
    const newContactColor = rgb(1, 0, 0);
    const constraintColor = rgb(0.7, 0.5, 1);
    const secretColor  = rgb(1, 0, 0);
    const zOffset = 0.01;

    const engine       = physics._engine;
    
    const bodies = $Physics.Composite.allBodies(engine.world);
    for (let b = 0; b < bodies.length; ++b) {
        const body = bodies[b];
        if (! body.entity && ! showSecrets) { continue; }

        const color =
              (! body.entity ? secretColor :
               (body.isSensor ? sensorColor:
                (body.isStatic ? staticColor :
                 (body.isSleeping ? sleepColor :
                  awakeColor))));
        
        const z = body.entity ? body.entity.z + zOffset : 100;
        for (let p = 0; p < body.parts.length; ++p) {
            const part = body.parts[p];
            const C = $Math.cos(part.angle);
            const S = $Math.sin(part.angle);

            let r = 4;
            if (body.circleRadius) {
                draw_disk(part.position, part.circleRadius, undefined, color, z);
                r = $Math.min(r, part.circleRadius - 2);
            } else {
                const V = part.vertices[0];
                draw_line(last_value(part.vertices), V, color, z);
                let maxR2 = magnitude_squared(V.x - part.position.x, V.y - part.position.y);
                for (let i = 1; i < part.vertices.length; ++i) {
                    const V = part.vertices[i];
                    maxR2 = $Math.max(magnitude_squared(V.x - part.position.x, V.y - part.position.y), maxR2);
                    draw_line(part.vertices[i - 1], V, color, z);
                }
                r = $Math.min($Math.sqrt(maxR2) - 2, r);
            }
            
            // Axes
            const axis = xy(r * C, r * S);
            draw_line(_objectSub(part.position, axis), _objectAdd(part.position, axis), color, z);
            let temp = axis.x; axis.x = -axis.y; axis.y = temp;
            draw_line(_objectSub(part.position, axis), _objectAdd(part.position, axis), color, z);
        }
    } // bodies

    const weldTri = [xy(0, 5), xy(4.330127018922194, -2.5), xy(-4.330127018922194, -2.5)];
    const constraints = $Physics.Composite.allConstraints(engine.world);
    for (let c = 0; c < constraints.length; ++c) {
        const constraint = constraints[c];
        const attachment = constraint.attachment;

        // Not a renderable constraint
        if (! attachment && ! showSecrets) { continue; }
        
        const type = attachment ? attachment.type : '';

        let pointA = constraint.pointA;
        let pointB = constraint.pointB;
        let zA = -Infinity, zB = -Infinity;
        
        if (constraint.bodyA) {
            pointA = _objectAdd(pointA, constraint.bodyA.position);
            zA = attachment ? constraint.bodyA.entity.z : 100;
        }
        
        if (constraint.bodyB) {
            pointB = _objectAdd(pointB, constraint.bodyB.position);
            zB = attachment ? constraint.bodyB.entity.z : 100;
        }
        const z = $Math.max(zA, zB) + zOffset;

        const color = attachment ? constraintColor : secretColor;
        
        if (type === 'spring') {
            // Choose the number of bends based on the rest length,
            // and then stretch
            const longAxis = _objectSub(pointB, pointA);
            const crossAxis = _objectMul(xy(-longAxis.y, longAxis.x),
                                         $clamp(8 - $Math.pow(constraint.stiffness, 0.1) * 8, 1, 7) / magnitude(longAxis));
            const numBends = $Math.ceil(attachment.length / 2.5);
            let prev = pointA;
            for (let i = 1; i < numBends; ++i) {
                const end = (i === 1 || i === numBends - 1);
                const u = (end ? i + 0.5 : i) / numBends;
                const v = end ? 0 : (2 * (i & 1) - 1);
                const curr = _objectAdd(pointA,
                                        _objectAdd(_objectMul(longAxis, u),
                                                   _objectMul(crossAxis, v))); 
                draw_line(prev, curr, color, z);
                prev = curr;
            }
            draw_line(prev, pointB, color, z);
        } else {
            // rod
            draw_line(pointA, pointB, color, z);
        }

        if (type === 'weld') {
            // Show a triangle to indicate that this attachment is rigid
            draw_poly(weldTri, color, undefined, pointB, constraint.bodyB.angle, undefined, z);
        } else if (type === 'pin') {
            // Show one disk
            draw_disk(pointA, 3, color, undefined, z);
        } else {
            // Show the two disks
            draw_disk(pointA, 3, undefined, color, z);
            draw_disk(pointB, 2.5, color, undefined, z);
        }
    }

    // For contacts, do not iterate over physics.pairs.list, as that
    // is the potentially O(n^2) cache of all pairs ever created and
    // most of them may not be active.

    const contactBox = xy(3, 3);
    for (const [body0, map] of physics._entityContactMap) {
        for (const [body1, contact] of map) {
            // Draw each only once, for the body with the lower ID
            if (body0.id < body1.id) {
                const z = $Math.max(contact.entityA.z, contact.entityB.z) + zOffset;
                draw_rect(contact.point0, contactBox, contactColor, undefined, 0, z);
                if (contact.point1) { draw_rect(contact.point1, contactBox, contactColor, undefined, 0, z); }
            }
        }
    }

    const newContactBox = xy(7, 7);
    for (let c = 0; c < physics._newContactArray.length; ++c) {
        const contact = physics._newContactArray[c];
        const z = $Math.max(contact.entityA.z, contact.entityB.z) + zOffset;

        // Size based on penetration
        newContactBox.x = newContactBox.y = $clamp(1 + contact.depth * 2, 1, 10);
        
        draw_rect(contact.point0, newContactBox, newContactColor, undefined, 0, z);
        if (contact.point1) { draw_rect(contact.point1, newContactBox, newContactColor, undefined, 0, z); }
    }
}


/*************************************************************************************/
//
// Graphics functions

// Snap points to the pixels that they cover. This follows our rule of
// integer pixel CORNERS and BOTTOM-RIGHT coverage rules at pixel
// centers.
var _pixelSnap = $Math.floor;

function transform_map_layer_to_ws_z(map, layer) {
    if (! map._type && map._type === 'map') {
        $error('First argument to transform_map_layer_to_ws_z() must be a map');
    }
    return layer * map.z_scale + map.z_offset;
}


function transform_ws_z_to_map_layer(map, z) {
    if (! map._type && map._type === 'map') {
        $error('First argument to transform_draw_z_to_map_layer() must be a map');
    }
    return (z - map.z_offset) / map.z_scale;
}


function transform_map_space_to_ws(map, map_coord) {
    return xy(map_coord.x * map.sprite_size.x + map._offset.x,
              map_coord.y * map.sprite_size.y + map._offset.y);
}


function transform_ws_to_map_space(map, ws_coord) {
    return xy((ws_coord.x - map._offset.x) / map.sprite_size.x,
              (ws_coord.y - map._offset.y) / map.sprite_size.y);
}


function transform_to(pos, angle, scale, coord) {
    const a = angle * -rotation_sign();
    const C = $Math.cos(a);
    const S = $Math.sin(a);
    
    const Xx =  C, Xy = S;
    const Yx = -S, Yy = C;

    const x = coord.x - pos.x, y = coord.y - pos.y;
    return xy((x * Xx + y * Yx) / scale.x,
              (x * Xy + y * Yy) / scale.y);
}

function transform_from(pos, angle, scale, coord) {
    const a = angle * -rotation_sign();
    const C = $Math.cos(a);
    const S = $Math.sin(a);

    const Xx =  C, Xy = S;
    const Yx = -S, Yy = C;

    const x = coord.x * scale.x, y = coord.y * scale.y;
    return xy(x * Xx + y * Xy + pos.x, x * Yx + y * Yy + pos.y);
}


function get_map_pixel_color(map, map_coord, layer, replacement_array) {
    layer = $Math.floor(layer || 0);
    let mx = $Math.floor(map_coord.x);
    let my = $Math.floor(map_coord.y);

    if (map.wrap_x) { mx = loop(mx, map.size.x); }
    if (map.wrap_y) { my = loop(my, map.size.y); }

    if ((layer >= 0) && (layer < map.layer.length) &&
        (mx >= 0) && (my >= 0) &&
        (mx < map.size.x) && (my < map.size.y)) {
        // In bounds
        
        let sprite = map.layer[layer][mx][my];
        if (sprite) {
            if (replacement_array) {
                for (let i = 0; i < replacement_array.length; i += 2) {
                    if (replacement_array[i] === sprite) {
                        sprite = replacement_array[i + 1];
                        break;
                    }
                }
            }
            
            // Map coord (0, 0) is the corner of the corner sprite.
            const ssX = sprite.size.x, ssY = sprite.size.y;
            const spriteCoord = {x:$clamp($Math.floor((map_coord.x - mx) * ssX), 0, ssX - 1),
                                 y:$clamp($Math.floor((map_coord.y - my) * ssY), 0, ssY - 1)};

            // Account for the automatic flipping that occurs to sprites when rendering
            if ($scaleY < 0) {
                spriteCoord.y = ssY - 1 - spriteCoord.y;
            }
            
            if ($scaleX < 0) {
                spriteCoord.x = ssX - 1 - spriteCoord.x;
            }
            
            return get_sprite_pixel_color(sprite, spriteCoord);
        }
    }

    // Out of bounds or no sprite
    return undefined;
}


function get_map_pixel_color_by_ws_coord(map, ws_coord, ws_z, replacement_array) {
    if (! map.spritesheet_table) { throw new Error('The first argument to get_map_pixel_color_by_draw_coord() must be a map'); }
    const layer = (((ws_z || 0) - $offsetZ) / $scaleZ - map.z_offset) / map.z_scale;
    return get_map_pixel_color(map, transform_ws_to_map_space(map, ws_coord), layer, replacement_array);
}

    
function get_map_sprite(map, map_coord, layer, replacement_array) {
    if (! map.spritesheet_table) { throw new Error('The first argument to get_map_sprite() must be a map'); }
    layer = $Math.floor(layer || 0) | 0;
    let mx = $Math.floor(map_coord.x);
    let my = $Math.floor(map_coord.y);

    if (map.wrap_x) { mx = loop(mx, map.size.x); }
    if (map.wrap_y) { my = loop(my, map.size.y); }
    
    if ((layer >= 0) && (layer < map.layer.length) &&
        (mx >= 0) && (my >= 0) &&
        (mx < map.size.x) && (my < map.size.y)) {
        // In bounds
        let sprite = map.layer[layer][mx][my];
        if (replacement_array) {
            for (let i = 0; i < replacement_array.length; i += 2) {
                if (replacement_array[i] === sprite) {
                    return replacement_array[i + 1];
                    break;
                }
            }
        }

        return sprite;

    } else {
        return undefined;
    }
}


function set_map_sprite(map, map_coord, sprite, layer) {
    layer = $Math.floor(layer || 0) | 0;
    let mx = $Math.floor(map_coord.x);
    let my = $Math.floor(map_coord.y);

    if (map.wrap_x) { mx = loop(mx, map.size.x); }
    if (map.wrap_y) { my = loop(my, map.size.y); }

    if ((layer >= 0) && (layer < map.layer.length) &&
        (mx >= 0) && (my >= 0) &&
        (mx < map.size.x) && (my < map.size.y)) {
        // In bounds
        map.layer[layer][mx][my] = sprite;
    }
}


function get_map_sprite_by_ws_coord(map, ws_coord, ws_z, replacement_array) {
    const layer = ((ws_z || 0) - $offsetZ) / ($scaleZ * map.z_scale);
    return get_map_sprite(map, transform_ws_to_map_space(map, ws_coord), layer, replacement_array);
}


function set_map_sprite_by_ws_coord(map, ws_coord, sprite, z) {
    const layer = ((z || 0) - $offsetZ) / ($scaleZ * map.z_scale);
    return set_map_sprite(map, transform_ws_to_map_space(map, ws_coord), sprite, layer);
}


function draw_map(map, min_layer, max_layer, replacements, pos, angle, scale, z_shift) {
    if (! map.layer && map.map && (arguments.length === 1)) {
        // named argument version
        min_layer = map.min_layer;
        max_layer = map.max_layer;
        replacements = map.replacement_array;
        pos = map.pos;
        angle = map.angle;
        scale = map.scale;
        z_shift = map.z;
        map = map.map; 
    }

    if (min_layer === undefined) { min_layer = 0; }

    if (max_layer === undefined) { max_layer = map.layer.length - 1; }

    if ((typeof $camera.zoom === 'function') && (min_layer !== max_layer)) {
        // Must draw layers separately when there is a zoom function.
        // Draw in order from back to front to preserve z-order.
        for (let L = min_layer; L <= max_layer; ++L) {
            draw_map(map, L, L, replacements, pos, angle, scale, z_shift);
        }
        return;
    }
    
    if (typeof scale === 'number') { scale = xy(scale, scale); }

    if (pos === undefined) { pos = xy(0, 0); }

    if (angle === undefined) { angle = 0; }

    if (scale === undefined) { scale = xy(1, 1); }

    z_shift = z_shift || 0;

    if (($camera.x !== 0) || ($camera.y !== 0) || ($camera.angle !== 0) || ($camera.zoom !== 1)) {
        // Use the z-value from the lowest layer for perspective. If the zoom is a
        // function, then draw_map() guarantees that there is only one
        // layer at a time!
        const z = (min_layer * map.z_scale + map.z_offset + z_shift) - $camera.z;
        
        // Transform the arguments to account for the camera
        const mag = _zoom(z);
        const C = $Math.cos($camera.angle) * mag, S = $Math.sin($camera.angle * rotation_sign()) * mag;
        const x = pos.x - $camera.x, y = pos.y - $camera.y;
        pos = {x: x * C + y * S, y: y * C - x * S};
        angle -= $camera.angle;
        scale = {x: scale.x * mag, y: scale.y * mag};
    }

    if (replacements !== undefined) {
        if (! Array.isArray(replacements)) { throw new Error('The replacements for draw_map() must be an array'); }
        if (replacements.length & 1 !== 0) { throw new Error('There must be an even number of elements in the replacements array'); }
        // Convert to a map for efficiency (we need to copy anyway)
        const array = replacements;
        replacements = new Map();
        const N = array.length;
        for (let i = 0; i < N; i += 2) {
            replacements.set(array[i], array[i + 1]);
        }
    }

    // Compute the map axes in draw space
    const drawU = xy($Math.cos(angle), $Math.sin(angle * rotation_sign()));
    const drawV = perp(drawU);
    drawU.x *= scale.x; drawU.y *= scale.x;
    drawV.x *= scale.y; drawV.y *= scale.y;

    const spriteSizeX = map.sprite_size.x;
    const spriteSizeY = map.sprite_size.y;
    
    // Handle map wrapping with a 4x4 grid
    const oldDrawOffsetX = $offsetX, oldDrawOffsetY = $offsetY;
    for (let shiftY = -1; shiftY <= +1; ++shiftY) {
        if (! map.wrap_y && shiftY !== 0) { continue; }
        
        for (let shiftX = -1; shiftX <= +1; ++shiftX) {
            if (! map.wrap_x && shiftX !== 0) { continue; }

            // Shift amount for this instance of the tiled map
            const mapSpaceOffset = xy(map.size.x * map.sprite_size.x * shiftX,
                                      map.size.y * map.sprite_size.y * shiftY);
            $offsetX = oldDrawOffsetX + drawU.x * mapSpaceOffset.x + drawV.x * mapSpaceOffset.y;
            $offsetY = oldDrawOffsetY + drawU.y * mapSpaceOffset.x + drawV.y * mapSpaceOffset.y;
            
            // Take the screen-space clip coordinates to draw coords.
            // This does nothing if there is no offset or scale
            const drawClip1 = xy(($clipX1 - $offsetX) / $scaleX, ($clipY1 - $offsetY) / $scaleY);
            const drawClip2 = xy(($clipX2 - $offsetX) / $scaleX, ($clipY2 - $offsetY) / $scaleY);

            // Take the draw-space clip coordinates to the min/max map
            // coords.  When rotated, this may cause significant
            // overdraw, as snapping to an axis-aligned bounding box
            // in the rotated map space could be fitting a diamond
            // with a square. 
            let mapX1, mapX2, mapY1, mapY2;
            {
                //$console.log(transform_to(pos, angle, scale, drawClip2));
                // Apply pos, angle, scale.
                // We have to consider all four corners for the rotation case.
                const temp1 = transform_ws_to_map_space(map, transform_to(pos, angle, scale, drawClip1)),
                      temp2 = transform_ws_to_map_space(map, transform_to(pos, angle, scale, drawClip2)),
                      temp3 = transform_ws_to_map_space(map, transform_to(pos, angle, scale, xy(drawClip1.x, drawClip2.y))),
                      temp4 = transform_ws_to_map_space(map, transform_to(pos, angle, scale, xy(drawClip2.x, drawClip1.y)));
                
                mapX1 = $Math.floor($Math.min(temp1.x, temp2.x, temp3.x, temp4.x));
                mapX2 = $Math.ceil ($Math.max(temp1.x, temp2.x, temp3.x, temp4.x));
                
                mapY1 = $Math.floor($Math.min(temp1.y, temp2.y, temp3.y, temp4.y));
                mapY2 = $Math.ceil ($Math.max(temp1.y, temp2.y, temp3.y, temp4.y));

                mapX1 = $Math.max(mapX1, 0);
                mapX2 = $Math.min(mapX2, map.size.x - 1);
                
                mapY1 = $Math.max(mapY1, 0);
                mapY2 = $Math.min(mapY2, map.size.y - 1);
            }

            // Setup draw calls for the layers. We process each cell
            // "vertically" within all layers from top to bottom in
            // the following code so that lower layers can be culled
            // when occluded.
            
            const numLayers = max_layer - min_layer + 1;
            const layerSpriteArrays = [];
            const layerZ = [];
            layerSpriteArrays.length = numLayers;
            layerZ.length = numLayers;
            for (let L = min_layer; L <= max_layer; ++L) {
                const layer = map.layer[L];
                const i = L - min_layer;
                
                const baseZ = layerZ[i] = (L * map.z_scale + map.z_offset + z_shift - $camera.z) * $scaleZ + $offsetZ;
                if (baseZ >= $clipZ1 && baseZ <= $clipZ2) {
                    layerSpriteArrays[i] = [];
                } 
            }

            // Compute the sprite calls. We pack them together into big
            // layer calls to reduce sorting, but since the map is
            // mutable we have to actually copy all elements for those
            // calls.

            const radius = $Math.hypot(map.sprite_size.x, map.sprite_size.y) * 0.5 *
                  $Math.max($Math.abs(scale.x), $Math.abs(scale.y));
            
            for (let mapX = mapX1; mapX <= mapX2; ++mapX) {
                for (let mapY = mapY1; mapY <= mapY2; ++mapY) {
                            
                    // Compute the screen coordinates. Sprites are
                    // rendered from centers, so offset each by 1/2
                    // the tile size.
                    const x = (mapX + 0.5) * map.sprite_size.x + map._offset.x;
                    const y = (mapY + 0.5) * map.sprite_size.y + map._offset.y;
                    
                    const screenX = (drawU.x * x + drawV.x * y + pos.x) * $scaleX + $offsetX;
                    const screenY = (drawU.y * x + drawV.y * y + pos.y) * $scaleY + $offsetY;
                    
                    // If there is rotation, this particular sprite
                    // column might be off screen
                    if ((screenX + radius < $clipX1 - 0.5) && (screenY + radius < $clipY1 - 0.5) &&
                        (screenX >= $clipX2 + radius + 0.5) && (screenY >= $clipY2 + radius + 0.5)) {
                        continue;
                    }
                    
                    // Process layers from the top down, so that we can occlusion cull
                    for (let L = max_layer; L >= min_layer; --L) {
                        const i = L - min_layer;
                        const baseZ = layerZ[i];
                        
                        // Sprite calls in this layer
                        const data = layerSpriteArrays[i];
                                                
                        if (! data) {
                            // This layer is z-clipped
                            continue;
                        }

                        let sprite = map.layer[L][mapX][mapY];
                    
                        if (sprite === undefined) {
                            // Empty sprite cell
                            continue;
                        }
                            
                        if (replacements && replacements.has(sprite)) {
                            // Perform replacement
                            sprite = replacements.get(sprite);
                            
                            // ...which may be empty
                            if (sprite === undefined) { continue; }
                        }

                        data.push({
                            spritesheetIndex: sprite.spritesheet._index[0],
                            cornerX:  sprite._x,
                            cornerY:  sprite._y,
                            sizeX:    sprite.size.x,
                            sizeY:    sprite.size.y,
                            angle:    angle,
                            scaleX:   scale.x * sprite.scale.x,
                            scaleY:   scale.y * sprite.scale.y,
                            hasAlpha: sprite._hasAlpha,
                            opacity:  1,
                            override_color: undefined,
                            x:        screenX,
                            y:        screenY
                        }); // push
                        
                        if (! sprite._hasAlpha) {
                            // No need to process other layers, since this sprite
                            // occludes everything under it.
                            break;
                        } // occlusion cull
                    } // y
                } // x
            } // For each layer L

            // Submit the non-empty draw calls
            for (let i = 0; i < numLayers; ++i) {
                // Sprite calls in this layer
                const data = layerSpriteArrays[i];
                const baseZ = layerZ[i];
                
                // Push the command if there were sprites.
                // Note that the z will be offset based on the order
                // of submission even if all baseZ values are the same.
                if (data && data.length > 0) {
                    _addGraphicsCommand({
                        opcode: 'SPR',
                        baseZ:  baseZ,
                        z:      baseZ,
                        data:   data
                    });
                }
            } // for each layer
        } // wrap_x
    } // wrap_y

    $offsetX = oldDrawOffsetX;
    $offsetY = oldDrawOffsetY;
}


function draw_color_tri(A, B, C, color_A, color_B, color_C, pos, angle, scale, z) {
    // Skip graphics this frame
    if (mode_frames % $graphicsPeriod !== 0) { return; }
    if (A.A) {
        // Object version
        z = A.z;
        angle = A.angle;
        scale = A.scale;
        pos = A.pos;
        color_A = A.color_A;
        color_B = A.color_B;
        color_C = A.color_C;
        C = A.C;
        B = A.B;
        A = A.A;
    }

    color_A = _colorToUint16(color_A);
    color_B = _colorToUint16(color_B);
    color_C = _colorToUint16(color_C);

    // TODO: transform to screen space
    // TODO: clip empty triangles
    // TODO: add graphics command
}



function draw_tri(A, B, C, color, outline, pos, angle, scale, z) {
    // Skip graphics this frame
    if (mode_frames % $graphicsPeriod !== 0) { return; }
    if (A.A) {
        // Object version
        z = A.z;
        angle = A.angle;
        scale = A.scale;
        pos = A.pos;
        outline = A.outline;
        color = A.color;
        C = A.C;
        B = A.B;
        A = A.A;
    }
    draw_poly([A, B, C], color, outline, pos, angle, scale, z);
}


function draw_disk(pos, radius, color, outline, z) {
    // Skip graphics this frame
    if (mode_frames % $graphicsPeriod !== 0) { return; }

    if (pos.pos) {
        // Object version
        outline = pos.outline;
        color = pos.color;
        radius = pos.radius;
        z = pos.z;
        pos = pos.pos;
    }

    z = (z || 0) - $camera.z;
    if (($camera.x !== 0) || ($camera.y !== 0) || ($camera.angle !== 0) || ($camera.zoom !== 1)) {
        // Transform the arguments to account for the camera
        const mag = _zoom(z);
        const C = $Math.cos($camera.angle) * mag, S = $Math.sin($camera.angle * rotation_sign()) * mag;
        const x = pos.x - $camera.x, y = pos.y - $camera.y;
        pos = {x: x * C + y * S, y: y * C - x * S};
        radius *= mag;
    }
    
    const skx = (z * $skewXZ), sky = (z * $skewYZ);
    let x = (pos.x + skx) * $scaleX + $offsetX, y = (pos.y + sky) * $scaleY + $offsetY;
    z = z * $scaleZ + $offsetZ;
    
    radius = (radius + 0.5) | 0;

    // Culling optimization
    if ((x - radius > $clipX2 + 0.5) || (y - radius > $clipY2 + 0.5) || (z > $clipZ2 + 0.5) ||
        (x + radius < $clipX1 - 0.5) || (y + radius < $clipY1 - 0.5) || (z < $clipZ1 - 0.5)) {
        return;
    }

    color   = _colorToUint16(color);
    outline = _colorToUint16(outline);

    _addGraphicsCommand({
        opcode: 'CIR',
        x: x,
        y: y,
        z: z,
        radius: radius,
        color: color,
        outline: outline
    });
}


function _colorToUint16(color) {
    if (color === undefined) { return 0; }
    
    const a = color.a;
    
    let c = 0xF000 >>> 0;
    if (a !== undefined) {
        // >>> 0 ensures uint32
        c = ((($clamp(a, 0, 1) * 15 + 0.5) & 0xf) << 12) >>> 0;
    }

    let r = 0, g = 0, b = 0, h = color.h;

    if (h !== undefined) {
        h = _loop(h, 0, 1);
        const s = $clamp(color.s, 0, 1), v = $clamp(color.v, 0, 1);

        // Convert to RGB
        // https://en.wikipedia.org/wiki/HSL_and_HSV#HSV_to_RGB
        let k = (5 + 6 * h) % 6;
        r = v - v * s * $Math.max(0, $Math.min(k, 4 - k, 1));

        k = (3 + 6 * h) % 6;
        g = v - v * s * $Math.max(0, $Math.min(k, 4 - k, 1));

        k = (1 + 6 * h) % 6;
        b = v - v * s * $Math.max(0, $Math.min(k, 4 - k, 1));
        
        /*
        r = v * (1 + s - s * $clamp($Math.abs($fract(h +  1 ) * 6 - 3) - 1, 0, 1));
        g = v * (1 + s - s * $clamp($Math.abs($fract(h + 2/3) * 6 - 3) - 1, 0, 1));
        b = v * (1 + s - s * $clamp($Math.abs($fract(h + 1/3) * 6 - 3) - 1, 0, 1));
        */
        
    } else {
        r = $clamp(color.r, 0, 1);
        g = $clamp(color.g, 0, 1);
        b = $clamp(color.b, 0, 1);
    }

    if (r !== undefined) {
        return (c | ((b * 15 + 0.5) << 8) | ((g * 15 + 0.5) << 4) | (r * 15 + 0.5)) >>> 0;
    } else {
        return 0xFFFF >>> 0;
    }
}


function draw_rect(pos, size, fill, border, angle, z) {
    if (pos.pos) {
        z = pos.z;
        angle = pos.angle;
        border = pos.outline;
        fill = pos.color;
        size = pos.size;
        pos = pos.pos;
    }
    
    angle = loop(angle || 0, -$Math.PI, $Math.PI);

    const rx = size.x * 0.5, ry = size.y * 0.5;
    if (($camera.angle === 0) && ($Math.min($Math.abs(angle), $Math.abs(angle - $Math.PI), $Math.abs(angle + $Math.PI)) < 1e-10)) {
        // Use the corner rect case for speed
        draw_corner_rect(xy(pos.x - rx, pos.y - ry), size, fill, border, z);
    } else if (($camera.angle === 0) && ($Math.min($Math.abs(angle - $Math.PI * 0.5), $Math.abs(angle + $Math.PI * 0.5)) < 1e-10)) {
        // Use the corner rect case for speed, rotated 90 degrees
        draw_corner_rect(xy(pos.x - ry, pos.y - rx), xy(size.y, size.x), fill, border, z);
    } else {
        const vertexArray = [xy(-rx, -ry), xy(rx, -ry), xy(rx, ry), xy(-rx, ry)];
        // Undo the camera angle transformation, since draw_poly will apply it again
        draw_poly(vertexArray, fill, border, pos, angle, undefined, z);
    }
}


function draw_poly(vertexArray, fill, border, pos, angle, scale, z) {
    // Skip graphics this frame
    if (mode_frames % $graphicsPeriod !== 0) { return; }
    
    if (vertexArray.vertex_array) {
        z = vertexArray.z;
        scale = vertexArray.scale;
        angle = vertexArray.angle;
        pos = vertexArray.pos;
        border = vertexArray.outline;
        fill = vertexArray.color;
        vertexArray = vertexArray.vertex_array;
    }
    
    angle = (angle || 0) * rotation_sign();
    let Rx = $Math.cos(angle), Ry = $Math.sin(-angle);

    // Clean up transformation arguments
    let Sx = 1, Sy = 1;

    if (scale !== undefined) {
        if (typeof scale === 'object') { Sx = scale.x; Sy = scale.y;
        } else { Sx = Sy = scale; }
    }

    let Tx = 0, Ty = 0;
    if (pos) { Tx = pos.x; Ty = pos.y; }

    switch (vertexArray.length) {
    case 0: return;
        
    case 1:
        {
            let p = vertexArray[0];
            if (pos) { p = {x: Tx + p.x, y: Ty + p.y}; }
            if (border) {
                draw_point(p, border, z);
            } else if (fill) {
                draw_point(p, fill, z);
            }
        }
        return;
        
    case 2:
        {
            let p = vertexArray[0];
            let q = vertexArray[1];
            if (pos || angle || (scale && scale !== 1)) {
                p = {x: Tx + p.x * Sx * Rx + p.y * Sy * Ry,
                     y: Ty + p.y * Sy * Rx - p.x * Sx * Ry};
                q = {x: Tx + q.x * Sx * Rx + q.y * Sy * Ry,
                     y: Ty + q.y * Sy * Rx - q.x * Sx * Ry};
            }

            if (border) {
                draw_line(p, q, border, z);
            } else if (fill) {
                draw_line(p, q, fill, z);
            }
        }
        return;
    }

    z = (z || 0) - $camera.z;
    if (($camera.x !== 0) || ($camera.y !== 0) || ($camera.angle !== 0) || ($camera.zoom !== 1)) {
        if (scale === undefined) { scale = {x:1, y:1}; }
        // Transform the arguments to account for the camera
        const mag = _zoom(z);
        const C = $Math.cos($camera.angle) * mag, S = $Math.sin($camera.angle * rotation_sign()) * mag;
        
        if (! pos) { pos = {x: 0, y: 0}; }
        if (typeof scale === undefined) { scale = {x: 1, y: 1}; }
        
        let x = Tx - $camera.x, y = Ty - $camera.y;
        Tx = x * C + y * S; Ty = y * C - x * S;
        angle -= $camera.angle;

        // Update matrix
        Rx = $Math.cos(angle); Ry = $Math.sin(-angle);
        Sx *= mag; Sy *= mag;
    }

    const skx = z * $skewXZ, sky = z * $skewYZ;

    // Preallocate the output array
    const N = vertexArray.length;
    const points = []; points.length = N * 2;
    
    // Compute the net transformation
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (let v = 0, p = 0; v < N; ++v, p += 2) {
        const vertex = vertexArray[v];

        // The object-to-draw and draw-to-screen transformations
        // could be concatenated to slightly reduce the amount of
        // math here, although it is maybe clearer and easier to debug
        // this way.
        
        // Object scale
        const Ax = vertex.x * Sx,          Ay = vertex.y * Sy;

        // Object rotate
        const Bx = Ax * Rx + Ay * Ry,      By = Ay * Rx - Ax * Ry;

        const Px = (Bx + Tx + skx) * $scaleX + $offsetX;
        const Py = (By + Ty + sky) * $scaleY + $offsetY;

        // Update bounding box
        minx = (Px < minx) ? Px : minx;    miny = (Py < miny) ? Py : miny;
        maxx = (Px > maxx) ? Px : maxx;    maxy = (Py > maxy) ? Py : maxy;
        
        points[p]     = Px;                points[p + 1] = Py;
    }

    z = z * $scaleZ + $offsetZ;
    
    fill   = _colorToUint16(fill);
    border = _colorToUint16(border);

    // Culling/all transparent optimization
    if ((minx > $clipX2 + 0.5) || (miny > $clipY2 + 0.5) || (z < $clipZ1 - 0.5) ||
        (maxx < $clipX1 - 0.5) || (maxy < $clipY1 - 0.5) || (z > $clipZ2 + 0.5) ||
        !((fill | border) & 0xf000)) {
        return;
    }

    _addGraphicsCommand({
        opcode: 'PLY',
        points: points,
        z: z,
        color: fill,
        outline: border
    });
}


function draw_corner_rect(corner, size, fill, outline, z) {

    if (corner.corner) {
        if (size !== undefined) {
            $error('Named argument version of draw_corner_rect() must have only one argument');
        }
        size = corner.size;
        fill = corner.color;
        outline = corner.outline;
        z = corner.z;
        corner = corner.corner;
    }
    
    if ($Math.abs($camera.angle) >= 1e-10) {
        // Draw using a polygon because it is rotated
        draw_rect({x: corner.x + size.x * 0.5, y: corner.y + size.y * 0.5}, size, fill, outline, 0, z);
        return;
    }

    z = (z || 0) - $camera.z;

    if (($camera.x !== 0) || ($camera.y !== 0)) {
        corner = {x: corner.x - $camera.x, y: corner.y - $camera.y};
    }

    if ($camera.zoom !== 1) {
        const m = _zoom(z);
        corner = {x: corner.x * m, y: corner.y * m};
        size = {x: size.x * m, y: size.y * m};
    }

    const skx = (z * $skewXZ), sky = (z * $skewYZ);
    let x1 = (corner.x + skx) * $scaleX + $offsetX, y1 = (corner.y + sky) * $scaleY + $offsetY;
    let x2 = (corner.x + size.x + skx) * $scaleX + $offsetX, y2 = (corner.y + size.y + sky) * $scaleY + $offsetY;
    z = z * $scaleZ + $offsetZ;

    fill = _colorToUint16(fill);
    outline = _colorToUint16(outline);

    // Sort coordinates
    let t1 = $Math.min(x1, x2), t2 = $Math.max(x1, x2);
    x1 = t1; x2 = t2;
    
    t1 = $Math.min(y1, y2), t2 = $Math.max(y1, y2);
    y1 = t1; y2 = t2;

    // Inclusive bounds for open top and left edges at the pixel center samples
    // low 0 -> 0, 0.5 -> 1
    // high 4 -> 3, 4.5 -> 4
    x1 = $Math.round(x1); y1 = $Math.round(y1);
    x2 = $Math.floor(x2 - 0.5); y2 = $Math.floor(y2 - 0.5);

    // Culling optimization
    if ((x2 < x1) || (y2 < y1) ||
        (x1 > $clipX2 + 0.5) || (x2 < $clipX1 - 0.5) || (z < $clipZ1 - 0.5) ||
        (y1 > $clipY2 + 0.5) || (y2 < $clipY1 - 0.5) || (z > $clipZ2 + 0.5)) {
        return;
    }

    _addGraphicsCommand({
        z: z,
        opcode: 'REC',
        x1: x1,
        y1: y1,
        x2: x2,
        y2: y2,
        fill: fill,
        outline: outline
    });
}

// Compute the zoom for this z value for the current camera
function _zoom(z) {
    return typeof $camera.zoom === 'number' ? $camera.zoom : $camera.zoom(z);
}


function draw_line(A, B, color, z, width) {
    if (A.A) {
        width = A.width;
        z = A.z;
        color = A.color;
        B = A.B;
        A = A.A;
    }
    
    if (width === undefined) { width = 1; }

    if (width * _zoom((z || 0) - $camera.z) >= 1.5) {
        // Draw a polygon instead of a thin line, as this will
        // be more than one pixel wide in screen space.
        let delta_x = B.y - A.y, delta_y = A.x - B.x;
        let mag = $Math.hypot(delta_x, delta_y);
        if (mag < 0.001) { return; }
        mag = width / (2 * mag);
        delta_x *= mag; delta_y *= mag;
        draw_poly(
            [{x:A.x - delta_x, y:A.y - delta_y},
             {x:A.x + delta_x, y:A.y + delta_y},
             {x:B.x + delta_x, y:B.y + delta_y},
             {x:B.x - delta_x, y:B.y - delta_y}],
            color, undefined, undefined, undefined, undefined, z);
        return;
    }
    
    z = (z || 0) - $camera.z;
    
    if (($camera.x !== 0) || ($camera.y !== 0) || ($camera.angle !== 0) || ($camera.zoom !== 1)) {
        // Transform the arguments to account for the camera
        const mag = _zoom(z);
        const C = $Math.cos($camera.angle) * mag, S = $Math.sin($camera.angle * rotation_sign()) * mag;
        let x = A.x - $camera.x, y = A.y - $camera.y;
        A = {x: x * C + y * S, y: y * C - x * S};
        x = B.x - $camera.x, y = B.y - $camera.y;
        B = {x: x * C + y * S, y: y * C - x * S};
        width *= mag;
    }
    
    const skx = (z * $skewXZ), sky = (z * $skewYZ);
    let x1 = (A.x + skx) * $scaleX + $offsetX, y1 = (A.y + sky) * $scaleY + $offsetY;
    let x2 = (B.x + skx) * $scaleX + $offsetX, y2 = (B.y + sky) * $scaleY + $offsetY;
    z = z * $scaleZ + $offsetZ

    color = _colorToUint16(color);

    // Offscreen culling optimization
    if (! (color & 0xf000) ||
        ($Math.min(x1, x2) > $clipX2 + 0.5) || ($Math.max(x1, x2) < $clipX1 - 0.5) || (z < $clipZ1 - 0.5) ||
        ($Math.min(y1, y2) > $clipY2 + 0.5) || ($Math.max(y1, y2) < $clipY1 - 0.5) || (z > $clipZ2 + 0.5)) {
        return;
    }

    _addGraphicsCommand({
        opcode: 'LIN',
        x1: x1,
        x2: x2,
        y1: y1,
        y2: y2,
        z: z,
        color: color,
        open1: false,
        open2: false
    });
}


function draw_point(pos, color, z) {
    // Skip graphics this frame
    if (mode_frames % $graphicsPeriod !== 0) { return; }

    if (pos.pos) {
        z = pos.z;
        color = pos.color;
        pos = pos.pos;
    }
    
    z = (z || 0) - $camera.z;

    if (($camera.x !== 0) || ($camera.y !== 0) || ($camera.angle !== 0) || ($camera.zoom !== 1)) {
        // Transform the arguments to account for the camera
        const mag = (typeof $camera.zoom === 'number') ? $camera.zoom : $camera.zoom(z);
        const C = $Math.cos($camera.angle) * mag, S = $Math.sin($camera.angle * rotation_sign()) * mag;
        const x = pos.x - $camera.x, y = pos.y - $camera.y;
        pos = {x: x * C + y * S, y: y * C - x * S};
    }
    
    const skx = z * $skewXZ, sky = z * $skewYZ;
    let x = (pos.x + skx) * $scaleX + $offsetX, y = (pos.y + sky) * $scaleY + $offsetY;
    z = z * $scaleZ + $offsetZ;
    
    x = $Math.floor(x); y = $Math.floor(y);
    
    if ((z < $clipZ1 - 0.5) || (z >= $clipZ2 + 0.5) ||
        (x < $clipX1) || (x > $clipX2) ||
        (y < $clipY1) || (y > $clipY2)) {
        return;
    }

    const prevCommand = $graphicsCommandList[$graphicsCommandList.length - 1];
    if (prevCommand && (prevCommand.baseZ === z) && (prevCommand.opcode === 'PIX')) {
        // Many points with the same z value are often drawn right
        // after each other.  Aggregate these (preserving their
        // ordering) for faster sorting and rendering.
        prevCommand.data.push((x + y * $SCREEN_WIDTH) >>> 0, _colorToUint16(color)); 
    } else {
        _addGraphicsCommand({
            z: z,
            baseZ: z,
            opcode: 'PIX',
            data: [(x + y * $SCREEN_WIDTH) >>> 0, _colorToUint16(color)]
        });
    }
}


function text_width(font, str, markup) {
    if (str === '') { return 0; }
    if (str === undefined) {
        throw new Error('text_width() requires a valid string as the second argument');
    }

    let formatArray = [{font: font, color: 0, shadow: 0, outline: 0, startIndex: 0}];
    if (markup) {
        str = $parseMarkup(str, formatArray);
    }

    // Don't add space after the last letter
    let width = -font._spacing.x;
    
    // Add the variable widths of the letters. Don't count the border
    // against the letter width.
    
    let formatIndex = 0;
    let offsetIndex = 0;
    while ((offsetIndex < formatArray[formatIndex].startIndex) || (offsetIndex > formatArray[formatIndex].endIndex)) { ++formatIndex; }
    let format = formatArray[formatIndex];

    for (let c = 0; c < str.length; ++c) {
        const chr = $fontMap[str[c]] || ' ';
        const bounds = font._bounds[chr];
        width += (bounds.x2 - bounds.x1 + 1) + _postGlyphSpace(str, c, format.font) - font._borderSize * 2 + bounds.pre + bounds.post;
        
        if (offsetIndex === formatArray[formatIndex].endIndex) {
            // Advance to the next format
            ++formatIndex;
            if (formatIndex < formatArray.length) {
                // Hold the final format when going off the end of the array
                format = formatArray[formatIndex];
            }
        }
    }
 
    return width;    
}


// Returns a string and appends to the array of state changes.
// Each has the form {color:..., outline:..., shadow:..., font:..., startIndex:...}
function $parseMarkupHelper(str, startIndex, stateChanges) {

    // Find the first unescaped {, or return if there is none
    let start = -1;
    do {
        start = str.indexOf('{', start + 1);
        if (start === -1) {
            // No markup found
            return str;
        }
    } while ((start !== 0) && (str[start - 1] === '\\'));

    // Find the *matching* close brace
    let end = start;
    let stack = 1;
    while (stack > 0) {
        let op = str.indexOf('{', end + 1); if (op === -1) { op = Infinity; }
        let cl = str.indexOf('}', end + 1); if (cl === -1) { cl = Infinity; }
        end = $Math.min(op, cl);
        
        if (end >= str.length) {
            throw new Error('Unbalanced {} in draw_text() with markup');
        }
        
        if (str[end - 1] !== '\\') {
            // Not escaped
            switch (str[end]) {
            case '{': ++stack; break;
            case '}': --stack; break;
            }
        }
    }

    const before = str.substring(0, start);
    const after  = str.substring(end + 1);
    const markup = str.substring(start + 1, end);

    let wasColor = false;
    const oldState = stateChanges[stateChanges.length - 1];
    const newState = Object.assign({}, oldState);
    newState.startIndex = startIndex + start;

    // Parse the markup
    let text = markup.replace(/^\s*(color|shadow|outline)\s*:\s*(#[A-Fa-f0-9]+|(rgb|rgba|gray|hsv|hsva)\([0-9%., ]+\))\s*/, function (match, prop, value) {
        wasColor = true;
        if (value[0] === '#') {
            value = $parseHexColor(value.substring(1));
        } else {
            // Parse the color specification
            let i = value.indexOf('(');

            // (Could also use $parse's indexing arguments to avoid all of this string work)
            const type = value.substring(0, i).trim();
            const param = value.substring(i + 1, value.length - 1).split(',');
            // Parse all parameters
            for (let i = 0; i < param.length; ++i) { param[i] = $parse(param[i].trim()).result; }

            // Convert to a structure
            switch (type) {
            case 'rgb':  value = {r:param[0], g:param[1], b:param[2]}; break;
            case 'rgba': value = {r:param[0], g:param[1], b:param[2], a:param[3]}; break;
            case 'hsv':  value = {h:param[0], s:param[1], v:param[2]}; break;
            case 'hsva': value = {h:param[0], s:param[1], v:param[2], a:param[3]}; break;
            case 'gray': value = {h:param[0]}; break;
            }
        }
        newState[prop] = _colorToUint16(value);
        return '';
    });

    if (! wasColor) {
        // The identifier regexp here is copied from
        // pyxlscript-compiler.js identifierPattern and must be kept
        // in sync.
        text = markup.replace(/^\s*(font|color|shadow|outline)\s*:\s*([Δ]?(?:[_A-Za-z][A-Za-z_0-9]*|[αβγΔδζηθιλμρσϕφχψτωΩ][_0-9]*(?:_[A-Za-z_0-9]*)?))\s+/, function (match, prop, value) {
            const v = window[value];
            if (v === undefined) {
                throw new Error('Global constant ' + value + ' used in draw_text markup is undefined.');
            } else if (prop === 'font' && v._type !== 'font') {
                throw new Error('Global constant ' + value + ' is not a font'); 
            } else if (prop !== 'font' && value.r === undefined && value.h === undefined) {
                throw new Error('Global constant ' + value + ' is not a color');
            }

            if (prop !== 'font') {
                v = _colorToUint16(v);
            }
            
            newState[prop] = v;
            return '';
        });
    }

    // Construct the new result string
    
    // The before part cannot contain markup, so copy it directly
    str = before;

    // Recursively process the main body
    stateChanges.push(newState);
    text = $parseMarkupHelper(text, before.length + startIndex, stateChanges);
    str += text;
    
    // Restore the old state after the body
    const restoreState = Object.assign({}, oldState);
    restoreState.startIndex = before.length + text.length + startIndex;
    stateChanges.push(restoreState);

    // Is there more after the first markup?
    if (after !== '') {
        str += $parseMarkupHelper(after, restoreState.startIndex, stateChanges);
    }
    
    return str;
}


function $parseMarkup(str, stateChanges) {
    // First instance.
    
    // Remove single newlines, temporarily protecting paragraph breaks.
    // This is intended to 
    str = str.replace(/ *\n{2,}/g, '¶');
    str = str.replace(/ *\n/g, ' ');
    str = str.replace(/¶/g, '\n\n');

    // Convert {br} to a newline
    str = str.replace(/\{br\}/g, '\n');

    str = $parseMarkupHelper(str, 0, stateChanges);

    // Efficiently remove degenerate state changes and compact
    {
        let src, dst;
        for (src = 0, dst = 0; src < stateChanges.length - 1; ++src) {
            if (src !== dst) { stateChanges[dst] = stateChanges[src]; }
            
            // Do not overwrite if this and the next element differ
            if (stateChanges[src].startIndex !== stateChanges[src + 1].startIndex) { ++dst; }
        }

        // Remove the remaining elements
        stateChanges.splice(dst, src - dst);
    }
    
    // Update the end indices (which are inclusive)
    for (let i = 0; i < stateChanges.length - 1; ++i) {
        stateChanges[i].endIndex = stateChanges[i + 1].startIndex - 1;
        // Width of this section, to be computed later
        stateChanges[i].width = 0;
    }
    // Force the last element to end at the string end
    stateChanges[stateChanges.length - 1].endIndex = str.length - 1;
    stateChanges[stateChanges.length - 1].width = 0;
    
    return str;
}


// Used for font rendering. Returns the font spacing, unless it is zero. In the zero case, the function
// tests for symbols (which include superscripts and subscripts, as well as the space character) that
// require spacing around them even if the font specifies font._spacing.x === 0.
function _postGlyphSpace(str, i, font) {
    if (font._spacing.x !== 0 || i >= str.length) {
        return font._spacing.x;
    } else {
        const symbolRegex = /[^A-Za-z0-9_αβγδεζηθικλμνξ§πρστυϕχψωςşğÆÀÁÂÃÄÅÇÈÉÊËÌÍÎÏØÒÓÔÕÖŒÑẞÙÚÛÜБДæàáâãäåçèéêëìíîïøòóôõöœñßùúûüбгдЖЗИЙЛПЦЧШЩЭЮЯЪЫЬжзийлпцчшщэюяъыьΓΔмнкΘΛΞΠİΣℵΦΨΩŞĞ]/;
        // test() will not fail on undefined or NaN, so ok to not safeguard the string conversions
        return symbolRegex.test($fontMap[str[i]] + $fontMap[str[i + 1]]) ? 1 : 0;
    }
}


/** Helper for draw_text() that operates after markup formatting has been processed. 
    offsetIndex is the amount to add to the indices in formatArray to account for
    the str having been shortened already. */
function _draw_text(offsetIndex, formatIndex, str, formatArray, pos, x_align, y_align, z, wrap_width, text_size, referenceFont) {
    $console.assert(typeof str === 'string');
    $console.assert(Array.isArray(formatArray));
    $console.assert(formatIndex < formatArray.length);
    $console.assert(typeof pos === 'object' && pos.x !== undefined);

    let format;

    if (offsetIndex < formatArray[formatIndex].startIndex || offsetIndex > formatArray[formatIndex].endIndex) {
        // Empty, just return newline
        return {x:0, y:referenceFont._charHeight};
    }
    
    // Identify the starting format. This snippet is repeated throughout the function.
    while ((offsetIndex < formatArray[formatIndex].startIndex) || (offsetIndex > formatArray[formatIndex].endIndex)) { ++formatIndex; }
    format = formatArray[formatIndex];

    // Store this starting formatIndex
    const startingOffsetIndex = offsetIndex;
    const startingFormatIndex = formatIndex;

    // Compute the width of the string for alignment purposes,
    // terminating abruptly in a recursive call if word wrapping is
    // required.
    let width = 0, currentWidth = 0;
    for (let c = 0; c < str.length; ++c, ++offsetIndex) {
        if (str[c] === '\n') {
            // Newline, process by breaking and recursively continuing
            const cur = str.substring(0, c).trimEnd();
            const firstLineBounds = _draw_text(startingOffsetIndex, startingFormatIndex, cur, formatArray, pos, x_align, y_align, z, wrap_width, text_size, referenceFont);

            // Update formatIndex
            while ((offsetIndex < formatArray[formatIndex].startIndex) || (offsetIndex > formatArray[formatIndex].endIndex)) { ++formatIndex; }
            format = undefined;

            $console.assert(formatIndex < formatArray.length);
            
            const restBounds = _draw_text(offsetIndex + 1, formatIndex, str.substring(c + 1), formatArray, {x:pos.x, y:pos.y + referenceFont.line_height / $scaleY},
                                          x_align, y_align, z, wrap_width, text_size - cur.length, referenceFont);
            firstLineBounds.x = $Math.max(firstLineBounds.x, restBounds.x);
            if (restBounds.y > 0) {
                firstLineBounds.y += referenceFont._spacing.y + restBounds.y;
            }
            return firstLineBounds;
        }
        
        const chr = $fontMap[str[c]] || ' ';
        const bounds = format.font._bounds[chr];

        const delta = (bounds.x2 - bounds.x1 + 1) + _postGlyphSpace(str, c, format.font) - format.font._borderSize * 2 + bounds.pre + bounds.post;
        currentWidth += delta;
        width += delta;

        // Word wrapping
        if ((wrap_width !== undefined) && (wrap_width > 0) && (width > wrap_width - format.font._spacing.x)) {
            // Perform word wrap, we've exceeded the available width
            // Search backwards for a place to break.
            const breakChars = ' \n\t,.!:/\\)]}\'"|`-+=*…\?¿¡';

            // Avoid breaking more than 25% back along the string
            const maxBreakSearch = $Math.max(1, (c * 0.25) | 0);
            let breakIndex = -1;
            for (let i = 0; (breakIndex < maxBreakSearch) && (i < breakChars.length); ++i) {
                breakIndex = $Math.max(breakIndex, str.lastIndexOf(breakChars[i], c));
            }
            
            if ((breakIndex > c) || (breakIndex < maxBreakSearch)) {
                // Give up and break at c
                breakIndex = c;
            }

            const cur = str.substring(0, breakIndex);          
            const firstLineBounds = _draw_text(startingOffsetIndex, startingFormatIndex, cur.trimEnd(), formatArray, pos, x_align, y_align, z, undefined, text_size, referenceFont);
            
            // Now draw the rest
            const next = str.substring(breakIndex);
            const nnext = next.trimStart();

            // Update the offset and formatIndex for the recursive call. Note that
            // we have to account for the extra whitespace trimmed from nnext
            offsetIndex = startingOffsetIndex + breakIndex + (next.length - nnext.length);

            // Search for the appropriate formatIndex
            formatIndex = startingFormatIndex;
            while ((offsetIndex < formatArray[formatIndex].startIndex) || (offsetIndex > formatArray[formatIndex].endIndex)) { ++formatIndex; }
            format = undefined;

            $console.assert(offsetIndex >= formatArray[formatIndex].startIndex && offsetIndex <= formatArray[formatIndex].endIndex);
            const restBounds = _draw_text(offsetIndex, formatIndex, nnext, formatArray, {x:pos.x, y:pos.y + referenceFont.line_height / $scaleY},
                                          x_align, y_align, z, wrap_width, text_size - cur.length - (next.length - nnext.length), referenceFont);
            firstLineBounds.x = $Math.max(firstLineBounds.x, restBounds.x);
            if (restBounds.y > 0) {
                firstLineBounds.y += referenceFont._spacing.y + restBounds.y;
            }
            return firstLineBounds;
        }
        
        if (offsetIndex === formatArray[formatIndex].endIndex) {
            // Advance to the next format
            format.width = currentWidth;
            currentWidth = 0;
            ++formatIndex;
            if (formatIndex < formatArray.length) {
                // Hold the final format when going off the end of the array
                format = formatArray[formatIndex];
            }
        }
    }

    // Don't add space after the very last letter
    width -= format.font._spacing.x;
    format.width -= format.font._spacing.x;

    z = z || 0;
    const skx = (z * $skewXZ), sky = (z * $skewYZ);
    let x = (pos.x + skx) * $scaleX + $offsetX, y = (pos.y + sky) * $scaleY + $offsetY;
    z = z * $scaleZ + $offsetZ;

    const height = referenceFont._charHeight;

    // Force alignment to retain relative integer pixel alignment
    x -= $Math.round(width * (1 + x_align) * 0.5);

    // Move back to account for the border and shadow padding
    if (x_align !== +1) { --x; }

    switch (y_align) {
    case -1: y -= referenceFont._borderSize; break; // Align to the top of the bounds
    case  0:
        // Middle. Center on a '2', which tends to have a typical height 
        const bounds = referenceFont._bounds['2'];
        const tileY = $Math.floor(bounds.y1 / referenceFont._charHeight) * referenceFont._charHeight;
        y -= $Math.round((bounds.y1 + bounds.y2) / 2) - tileY;
        break;
    case  1: y -= referenceFont._baseline; break; // baseline
    case  2: y -= (referenceFont._charHeight - referenceFont._borderSize * 2 - referenceFont._shadowSize); break; // bottom of bounds
    }


    // Center and round. Have to call round() because values may
    // be negative
    x = $Math.round(x) | 0;
    y = $Math.round(y) | 0;

    if ((x > $clipX2) || (y > $clipY2) || (y + height < $clipY1) || (x + width < $clipX1) ||
        (z > $clipZ2 + 0.5) || (z < $clipZ1 - 0.5)) {
        // Cull when off-screen
    } else {
        // Break by formatting, re-traversing the formatting array.
        // Reset to the original formatIndex, since it was previously
        // incremented while traversing the string to compute width.
        offsetIndex = startingOffsetIndex;
        formatIndex = startingFormatIndex;
        format = formatArray[formatIndex];
        str = str.substring(0, text_size);

        while ((str.length > 0) && (formatIndex < formatArray.length)) {
            // offsetIndex increases and the string itself is
            // shortened throughout this loop.
    
            // Adjust for the baseline relative to the reference font
            const dy = format.font._baseline - referenceFont._baseline;

            const endIndex = format.endIndex - offsetIndex;
            _addGraphicsCommand({
                opcode:  'TXT',
                str:     str.substring(0, endIndex + 1),
                fontIndex: format.font._index[0],
                x:       x,
                y:       y - dy,
                z:       z,
                color:   format.color,
                outline: format.outline,
                shadow:  format.shadow,
                height:  height,
                width:   format.width,
            });

            x += format.width;

            // Should adjust for the relative y baselines of the fonts,
            // changing the returned bounds accordingly

            offsetIndex = format.endIndex + 1;

            // Process the characters immediately after the end index.
            str = str.substring(endIndex + 1);
            
            ++formatIndex;
            format = formatArray[formatIndex];
        }
    }

    // The height in memory is inflated by 3 for the outline on top
    // and shadow and outline on the bottom. Return the tight
    // bound on the characters themselves.
    return {x: width, y: height - 3};
}


/** Processes formatting and invokes _draw_text() */
function draw_text(font, str, pos, color, shadow, outline, x_align, y_align, z, wrap_width, text_size, markup) {
    // Skip graphics this frame
    if (mode_frames % $graphicsPeriod !== 0) { return; }
    
    if (font && font.font) {
        // Keyword version
        text_size = font.text_size;
        wrap_width = font.wrap_width;
        z = font.z;
        y_align = font.y_align;
        x_align = font.x_align;
        outline = font.outline;
        shadow = font.shadow;
        color = font.color;
        pos = font.pos;
        str = font.text;
        markup = font.markup;
        font = font.font;
    }

    if (font === undefined || font._url === undefined) {
        throw new Error('draw_text() requires a font as the first argument');
    }
    
    if (pos === undefined) {
        throw new Error('draw_text() requires a pos');
    }

    if (typeof str !== 'string') {
        str = unparse(str);
    }
    
    if (str === '') { return {x:0, y:0}; }

    z = (z || 0) - $camera.z;

    if (($camera.x !== 0) || ($camera.y !== 0) || ($camera.angle !== 0) || ($camera.zoom !== 1)) {
        // Transform the arguments to account for the camera
        const mag = (typeof $camera.zoom === 'number') ? $camera.zoom : $camera.zoom(z);
        const C = $Math.cos($camera.angle) * mag, S = $Math.sin($camera.angle * rotation_sign()) * mag;
        const x = pos.x - $camera.x, y = pos.y - $camera.y;
        pos = {x: x * C + y * S, y: y * C - x * S};
    }
    
    const stateChanges = [{
        font:       font,
        color:      _colorToUint16(color),
        shadow:     _colorToUint16(shadow),
        outline:    _colorToUint16(outline),
        startIndex: 0,
        endIndex:   str.length - 1
    }];
    
    if (markup) {
        str = $parseMarkup(str, stateChanges);
    }

    if (text_size === undefined) {
        text_size = str.length;
    }

    switch (x_align) {
    case undefined: case 'left': x_align = -1; break;
    case 'middle': case 'center': x_align = 0; break;
    case 'right':  x_align = +1; break;
    }

    switch (y_align) {
    case 'top': y_align = -1; break;
    case 'center': case 'middle': y_align = 0; break;
    case undefined: case 'baseline': y_align = +1; break;
    case 'bottom': y_align = +2; break;
    }
    
    // Debug visualize the markup:
    // for (let i = 0; i < stateChanges.length; ++i) { $console.log(str.substring(stateChanges[i].startIndex, stateChanges[i].endIndex + 1)); }

    // Track draw calls generated by _draw_text
    const first$graphics_command_index = $graphicsCommandList.length;
    const bounds = _draw_text(0, 0, str, stateChanges, pos, x_align, y_align, z, wrap_width, text_size, font);

    if ((bounds.y > font.line_height) && (y_align === 0 || y_align === 2)) {
        let y_shift = 0;
        if (y_align === 0) {
            // Center
            y_shift = font.line_height / 2 - bounds.y / 2;
        } else {
            // Bottom
            y_shift = font.line_height - bounds.y;
        }
        
        // Multiline needing vertical adjustment. Go back to the issued
        // draw calls and shift them vertically as required.
        for (let i = first$graphics_command_index; i < $graphicsCommandList.length; ++i) {
            $graphicsCommandList[i].y += y_shift;
        }
    }

    return bounds;
}


/* Returns a shallow copy */
function _clone(a) {
    if (a instanceof Array) {
        return a.slice();
    } else if (typeof a === 'Object') {
        return Object.assign({}, a);
    } else {
        return a;
    }
}


function $clamp(x, L, H) {
    return $Math.max($Math.min(x, H), L);
}


function get_sprite_pixel_color(spr, pos, result) {
    if (! (spr && spr.spritesheet)) {
        throw new Error('Called get_sprite_pixel_color() on an object that was not a sprite asset. (' + unparse(spr) + ')');
    }

    const x = $Math.floor((spr.scale.x > 0) ? pos.x : (spr.size.x - 1 - pos.x));
    const y = $Math.floor((spr.scale.y > 0) ? pos.y : (spr.size.y - 1 - pos.y));
    
    if ((x < 0) || (x >= spr.size.x) || (y < 0) || (y >= spr.size.y)) {
        if (result) {
            result.a = result.r = result.g = result.b = 0;
        } else {
            return undefined;
        }
    } else {
        const sheet = spr.spritesheet;
        const pixel = sheet._uint16Data[(spr._x + x) + (spr._y + y) * sheet._uint16Data.width];

        result = result || {r:0, g:0, b:0, a:0};
        
        result.a = ((pixel >>> 12) & 0xf) * (1 / 15);
        result.b = ((pixel >>> 8) & 0xf) * (1 / 15);
        result.g = ((pixel >>> 4) & 0xf) * (1 / 15);
        result.r = (pixel & 0xf) * (1 / 15);
        
        return result;
    }
}


function draw_sprite_corner_rect(CC, corner, size, z) {
    if (! (CC && CC.spritesheet)) {
        throw new Error('Called draw_sprite_corner_rect() on an object that was not a sprite asset. (' + unparse(CC) + ')');
    }

    z = z || 0;
    const skx = (z * $skewXZ), sky = (z * $skewYZ);
    let x1 = (corner.x + skx) * $scaleX + $offsetX, y1 = (corner.y + sky) * $scaleY + $offsetY;
    let x2 = (corner.x + size.x + skx) * $scaleX + $offsetX, y2 = (corner.y + size.y + sky) * $scaleY + $offsetY;
    z = z * $scaleZ + $offsetZ;

    // Sort coordinates
    let t1 = $Math.min(x1, x2), t2 = $Math.max(x1, x2);
    x1 = t1; x2 = t2;
    
    t1 = $Math.min(y1, y2), t2 = $Math.max(y1, y2);
    y1 = t1; y2 = t2;

    // Lock to the pixel grid before computing offsets
    x1 = $Math.round(x1); y1 = $Math.round(y1);
    x2 = $Math.floor(x2 - 0.5); y2 = $Math.floor(y2 - 0.5);
    
    const centerX = (x2 + x1) / 2, centerY = (y2 + y1) / 2;

    // We always put a tile in the center, so the width is based on
    // the ceiling of the *half* width, not the full width. Note the
    // the number of tiles in each direction is therefore guaranteed
    // to be odd.
    const numTilesX = 1 + $Math.ceil((x2 - x1 + 1) / (2 * CC.size.x) - 0.49) * 2;
    const numTilesY = 1 + $Math.ceil((y2 - y1 + 1) / (2 * CC.size.y) - 0.49) * 2;
    
    // Iterate over center box, clipping at its edges
    const spriteCenter = xy(0,0);
    $pushGraphicsState(); {
        intersect_clip(xy(x1, y1), xy(x2 - x1 + 1, y2 - y1 + 1));
        
        for (let y = 0; y < numTilesY; ++y) {
            // Transform individual pixel coordinates *back* to game
            // coords for the draw_sprite call to handle clipping and
            // insertion into the queue.
            spriteCenter.y = ((centerY + (y - (numTilesY - 1) * 0.5) * CC.size.y) - $offsetY) / $scaleY;
            for (let x = 0; x < numTilesX; ++x) {
                spriteCenter.x = ((centerX + (x - (numTilesX - 1) * 0.5) * CC.size.x) - $offsetX) / $scaleX;
                draw_sprite(CC, spriteCenter, 0, undefined, 1, z);
            }
        }
    } $popGraphicsState();
    
    // Generate relative sprites
    const LT = CC.spritesheet[$Math.max(0, CC._tileX - 1)][$Math.max(0, CC._tileY - 1)];
    const CT = CC.spritesheet[$Math.max(0, CC._tileX    )][$Math.max(0, CC._tileY - 1)];
    const RT = CC.spritesheet[$Math.max(0, CC._tileX + 1)][$Math.max(0, CC._tileY - 1)];

    const LC = CC.spritesheet[$Math.max(0, CC._tileX - 1)][$Math.max(0, CC._tileY    )];
    const RC = CC.spritesheet[$Math.max(0, CC._tileX + 1)][$Math.max(0, CC._tileY    )];

    const LB = CC.spritesheet[$Math.max(0, CC._tileX - 1)][$Math.max(0, CC._tileY + 1)];
    const CB = CC.spritesheet[$Math.max(0, CC._tileX    )][$Math.max(0, CC._tileY + 1)];
    const RB = CC.spritesheet[$Math.max(0, CC._tileX + 1)][$Math.max(0, CC._tileY + 1)];

    // Centers of the sprites on these edges
    const left   = ((x1 - CC.size.x * 0.5) - $offsetX) / $scaleX - 0.5;
    const right  = ((x2 + CC.size.x * 0.5) - $offsetX) / $scaleX + 1;
    const top    = ((y1 - CC.size.y * 0.5) - $offsetY) / $scaleY - 0.5;
    const bottom = ((y2 + CC.size.y * 0.5) - $offsetY) / $scaleY + 1;
    
    // Top and bottom
    $pushGraphicsState(); {
        intersect_clip(xy(x1, $clipY1), xy(x2 - x1 + 1, $clipY2 - $clipY1 + 1));
        
        for (let x = 0; x < numTilesX; ++x) {
            spriteCenter.x = ((centerX + (x - (numTilesX - 1) * 0.5) * CC.size.x) - $offsetX) / $scaleX;

            spriteCenter.y = top;
            draw_sprite(CT, spriteCenter, 0, undefined, 1, z);
            
            spriteCenter.y = bottom;
            draw_sprite(CB, spriteCenter, 0, undefined, 1, z);
        }
    } $popGraphicsState();

    // Sides
    $pushGraphicsState(); {
        intersect_clip(xy($clipX1, y1), xy($clipX2 - $clipX1 + 1, y2 - y1 + 1));
        
        for (let y = 0; y < numTilesY; ++y) {
            spriteCenter.y = ((centerY + (y - (numTilesY - 1) * 0.5) * CC.size.y) - $offsetY) / $scaleY;

            spriteCenter.x = left;
            draw_sprite(LC, spriteCenter, 0, undefined, 1, z);
            
            spriteCenter.x = right;
            draw_sprite(RC, spriteCenter, 0, undefined, 1, z);
        }
    } $popGraphicsState();

    // Corners (no new clipping needed)
    {
        // Left Top
        spriteCenter.x = left; spriteCenter.y = top;
        draw_sprite(LT, spriteCenter, 0, undefined, 1, z);
        
        // Right Top
        spriteCenter.x = right;
        draw_sprite(RT, spriteCenter, 0, undefined, 1, z);

        // Left Bottom
        spriteCenter.x = left; spriteCenter.y = bottom;
        draw_sprite(LB, spriteCenter, 0, undefined, 1, z);

        // Right Bottom
        spriteCenter.x = right;
        draw_sprite(RB, spriteCenter, 0, undefined, 1, z);
    }
}


// Returns the original pos, or a new object that is transformed by
// angle, scale, and the current drawing options if pivot is nonzero.
function _maybeApplyPivot(pos, pivot, angle, scale) {
    if (! pivot || (pivot.x === 0 && pivot.y === 0)) {
        return pos;
    }

    let scaleX = 1, scaleY = 1;
    if (scale) {
        if (is_number(scale)) {
            scaleX = scaleY = scale;
        } else {
            scaleX = scale.x;
            scaleY = scale.y;
        }
    }

    if (angle === undefined) { angle = 0; }
    
    // Raw sprite offset
    // Scale into sprite space
    let deltaX = pivot.x * $Math.sign($scaleX) * scaleX;
    let deltaY = pivot.y * $Math.sign($scaleY) * scaleY;
    
    // Rotate into sprite space
    const C = $Math.cos(angle);
    const S = $Math.sin(angle) * -rotation_sign();
    return {x: pos.x - (deltaX * C + S * deltaY),
            y: pos.y - (deltaY * C - S * deltaX)};
}


function draw_sprite(spr, pos, angle, scale, opacity, z, override_color, blend) {
    // Skip graphics this frame
    if (mode_frames % $graphicsPeriod !== 0) { return; }

    if (spr && spr.sprite) {
        // This is the "keyword" version of the function
        z = spr.z;
        opacity = spr.opacity;
        scale = spr.scale;
        angle = spr.angle;
        pos = spr.pos;
        override_color = spr.override_color;
        blend = spr.blend;
        spr = spr.sprite;
    }

    const multiply = blend === 'multiply';

    if (opacity <= 0) { return; }

    if (Array.isArray(spr) && spr.sprite_size && Array.isArray(spr[0])) {
        // The sprite was a spritesheet. Grab the first element
        spr = spr[0][0];
    }

    if (! (spr && spr.spritesheet)) {
        throw new Error('Called draw_sprite() on an object that was not a sprite asset. (' + unparse(spr) + ')');
    }
    
    z = (z || 0) - $camera.z;
    angle = angle || 0;

    pos = _maybeApplyPivot(pos, spr.pivot, angle, scale);

    if (($camera.x !== 0) || ($camera.y !== 0) || ($camera.angle !== 0) || ($camera.zoom !== 1)) {
        // Transform the arguments to account for the camera
        const mag = _zoom(z);
        const C = $Math.cos($camera.angle) * mag, S = $Math.sin($camera.angle * rotation_sign()) * mag;
        const x = pos.x - $camera.x, y = pos.y - $camera.y;
        pos = {x: x * C + y * S, y: y * C - x * S};
        angle -= $camera.angle;

        switch (typeof scale) {
        case 'number': scale = {x: scale, y: scale}; break;
        case 'undefined': scale = {x: 1, y: 1}; break;
        }
        scale = {x: scale.x * mag, y: scale.y * mag};
    }
    
    const skx = z * $skewXZ, sky = z * $skewYZ;
    const x = (pos.x + skx) * $scaleX + $offsetX;
    const y = (pos.y + sky) * $scaleY + $offsetY;
    z = z * $scaleZ + $offsetZ;

    let scaleX = 1, scaleY = 1;
    if ((scale !== 0) && (typeof scale === 'number')) {
        scaleX = scaleY = scale;
    } if (scale && scale.x && scale.y) {
        scaleX = scale.x;
        scaleY = scale.y;
    }
    
    // Apply the sprite's own flipping
    scaleX *= spr.scale.x; scaleY *= spr.scale.y;
    
    opacity = $Math.max(0, $Math.min(1, (opacity === undefined) ? 1 : opacity));
    const radius = spr._boundingRadius * $Math.max($Math.abs(scaleX), $Math.abs(scaleY));

    if ((opacity <= 0) || (x + radius < $clipX1 - 0.5) || (y + radius < $clipY1 - 0.5) ||
        (x >= $clipX2 + radius + 0.5) || (y >= $clipY2 + radius + 0.5) ||
        (z < $clipZ1 - 0.5) || (z >= $clipZ2 + 0.5)) {
        return;
    }

    // Don't use rotation_sign() on the angle, because the angle
    // WILL be interpreted as CCW when the queued command actually
    // executes.

    if (override_color) {
        // have to clone and convert to RGB space
        override_color = rgba(override_color);
    }    

    $console.assert(spr.spritesheet._index[0] < $spritesheetArray.length);

    const sprElt = {
        spritesheetIndex:  spr.spritesheet._index[0],
        cornerX:       spr._x,
        cornerY:       spr._y,
        sizeX:         spr.size.x,
        sizeY:         spr.size.y,
        
        angle:         (angle || 0),
        scaleX:        scaleX,
        scaleY:        scaleY,
        hasAlpha:      spr._hasAlpha,
        opacity:       opacity,
        override_color: override_color,
        multiply:      multiply,
        x:             x,
        y:             y
    };

    /*
    $console.assert(sprElt.spritesheetIndex >= 0 &&
                   sprElt.spritesheetIndex < $spritesheetArray.length,
                   spr._name + ' has a bad index: ' + sprElt.spritesheetIndex);
    */
    
    // Aggregate multiple sprite calls
    const prevCommand = $graphicsCommandList[$graphicsCommandList.length - 1];
    if (prevCommand && (prevCommand.baseZ === z) && (prevCommand.opcode === 'SPR') &&
        (prevCommand.clipX1 === $clipX1) && (prevCommand.clipX2 === $clipX2) &&
        (prevCommand.clipY1 === $clipY1) && (prevCommand.clipY2 === $clipY2)) {
        // Modify the existing command to reduce sorting demands for scenes
        // with a large number of sprites
        prevCommand.data.push(sprElt);
    } else {
        _addGraphicsCommand({
            opcode:       'SPR',
            // Comparison z for detecting runs of sprites
            baseZ:         z,

            // Sorting Z
            z:             z,
            data: [sprElt]});
    }
}


// Can't be implemented as min(loop(x,k), k - loop(x,k)) because
// that doesn't handle fractional values in the desired way.
function oscillate(x, lo, hi) {
    if (lo === undefined) {
        lo = 0; hi = 1;
    } else if (hi === undefined) {
        // Legacy version
        hi = lo;
        lo = 0;
    }

    if (hi <= lo) { throw new Error("oscillate(x, lo, hi) must have hi > lo"); }
    x -= lo;
    hi -= lo;
    
    const k = 2 * hi;
    x = loop(x, k);
    return ((x < hi) ? x : k - x) + lo;
}


function clamp(x, lo, hi) {
    // Test for all three being Numbes, which have a toFixed method
    if (x.toFixed && lo.toFixed && hi.toFixed) {
        return x < lo ? lo : x > hi ? hi : x;
    } else {
        return min(max(x, lo), hi);
    }
}

// On numbers only
function _loop(x, lo, hi) {
    x -= lo;
    hi -= lo;
    return (x - $Math.floor(x / hi) * hi) + lo;
}

function loop(x, lo, hi) {
    if (typeof x === 'object') {
        // Vector version
        const c = x.constructor ? x.constructor() : Object.create(null);

        if (typeof lo === 'object') {
            if (typeof hi === 'object') {
                for (let key in x) { c[key] = loop(x[key], lo[key], hi[key]); }
            } else {
                for (let key in x) { c[key] = loop(x[key], lo[key], hi); }
            }
        } else if (typeof hi === 'object') {
            for (let key in x) { c[key] = loop(x[key], lo, hi[key]); }
        } else {
            for (let key in x) { c[key] = loop(x[key], lo, hi); }
        }
        
        return c;
    }

    
    if (hi === undefined) {
        hi = lo;
        lo = 0;
    }

    if (hi === undefined) { hi = 1; }

    return _loop(x, lo, hi);
}


function get_background() {
    return $background;
}


function set_background(c) {
    if (Array.isArray(c) && c.sprite_size && Array.isArray(c[0])) {
        // c was a sprite sheet
        c = c[0][0];
    }

    if (c.spritesheet && (c.spritesheet.size.x !== $SCREEN_WIDTH || c.spritesheet.size.y !== $SCREEN_HEIGHT ||
                          c.size.x !== $SCREEN_WIDTH || c.size.y !== $SCREEN_HEIGHT)) {
        throw new Error('The sprite and its spritesheet for set_background() must be exactly the screen size.')
    }
    
    $background = c;
}


// Transform v into the reference frame of entity
function _toFrame(entity, v, out) {
    // Translate
    const x = v.x - entity.pos.x;
    const y = v.y - entity.pos.y;
    
    // Rotate
    let c = $Math.cos(entity.angle * rotation_sign());
    let s = $Math.sin(entity.angle * rotation_sign());
    
    if (out === undefined) { out = {x:0, y:0}; }
    
    out.x = x * c + y * s;
    out.y = y * c - x * s;
    
    return out;
}


function draw_bounds(entity, color, recurse) {
    if (! entity.pos) {
        throw new Error('draw_entityBounds() must be called on an object with at least a pos property');
    }
    
    if (recurse === undefined) { recurse = true; }
    color = color || rgb(0.6, 0.6, 0.6);
    const angle = (entity.angle || 0) * rotation_sign();
    const scale = entity.scale || {x:1, y:1};

    const pos = _maybeApplyPivot(entity.pos, entity.pivot, entity.angle, scale);
    
    // Bounds:
    const z = entity.z + 0.01;
    if ((entity.shape === 'disk') && entity.size) {
        draw_disk(pos, entity.size.x * 0.5 * scale.x, undefined, color, z)
    } else if (entity.size) {
        const u = {x: $Math.cos(angle) * 0.5, y: $Math.sin(angle) * 0.5};
        const v = {x: -u.y, y: u.x};
        u.x *= entity.size.x * scale.x; u.y *= entity.size.x * scale.x;
        v.x *= entity.size.y * scale.y; v.y *= entity.size.y * scale.y;

        const A = {x: pos.x - u.x - v.x, y: pos.y - u.y - v.y};
        const B = {x: pos.x + u.x - v.x, y: pos.y + u.y - v.y};
        const C = {x: pos.x + u.x + v.x, y: pos.y + u.y + v.y};
        const D = {x: pos.x - u.x + v.x, y: pos.y - u.y + v.y};
        draw_line(A, B, color, z);
        draw_line(B, C, color, z);
        draw_line(C, D, color, z);
        draw_line(D, A, color, z);
    } else {
        draw_point(pos, color, z);
    }

    // Axes
    {
        const u = {x: $Math.cos(angle) * 16, y: $Math.sin(angle) * 16};
        const v = {x: -u.y, y: u.x};
        u.x *= scale.x; u.y *= scale.x;
        v.x *= scale.y; v.y *= scale.y;

        // Do not apply the pivot to the axes
        const B = {x: entity.pos.x + u.x, y: entity.pos.y + u.y};
        const C = {x: entity.pos.x + v.x, y: entity.pos.y + v.y};
        
        draw_line(entity.pos, B, rgb(1,0,0), z);
        draw_line(entity.pos, C, rgb(0,1,0), z);
    }

    if (entity.child_array && recurse) {
        for (let i = 0; i < entity.child_array; ++i) {
            debugDrawEntity(entity.child_array[c], color, recurse);
        }
    }
}


function _getAABB(e, aabb) {
    // Take the bounds to draw space
    let w = (e.scale ? e.scale.x : 1) * e.size.x;
    let h = (e.scale ? e.scale.y : 1) * e.size.y;
    if ((e.shape !== 'disk') && (e.angle !== undefined)) {
        const c = $Math.abs($Math.cos(e.angle));
        const s = $Math.abs($Math.sin(e.angle));
        const x = w * c + h * s;
        const y = h * c + w * s;
        w = x; h = y;
    }
    w *= 0.5;
    h *= 0.5;
    aabb.max.x = $Math.max(aabb.max.x, e.pos.x + w);
    aabb.min.x = $Math.min(aabb.min.x, e.pos.x - w);
    aabb.max.y = $Math.max(aabb.max.y, e.pos.y + h);
    aabb.min.y = $Math.min(aabb.min.y, e.pos.x - h);

    // Recurse
    if (e.child_array) {
        for (let i = 0; i < e.child_array.length; ++i) {
            _getAABB(e.child_array[i], aabb);
        }
    }
}


function axis_aligned_draw_box(e) {
    const aabb = {max: xy(-Infinity, -Infinity),
                  min: xy( Infinity,  Infinity)};
    _getAABB(e, aabb);
    return {pos: xy((aabb.max.x + aabb.min.x) * 0.5,
                    (aabb.max.y + aabb.min.y) * 0.5),
            shape: 'rect',
            scale: xy(1, 1),
            angle: 0,
            size: xy(aabb.max.x - aabb.min.x,
                     aabb.max.y - aabb.min.y)};            
}


/** All arguments except the ray are xy(). Clones only the ray. Assumes that (0, 0) is the grid origin*/
function _makeRayGridIterator(ray, numCells, cellSize) {

    const it = {
        numCells:          numCells,
        enterDistance:     0,
        enterAxis:         'x',
        ray:               deep_clone(ray),
        cellSize:          cellSize,
        insideGrid:        true,
        containsRayOrigin: true,
        index:             xy(0, 0),
        tDelta:            xy(0, 0),
        step:              xy(0, 0),
        exitDistance:      xy(0, 0),
        boundaryIndex:     xy(0, 0)
    };

    /*
    if (gridOriginIndex.x !== 0 || gridOriginIndex.y !== 0) {
        // Change to the grid's reference frame
        ray.origin.x -= gridOrigin.x;
        ray.origin.y -= gridOrigin.y;
    }
*/

    //////////////////////////////////////////////////////////////////////
    // See if the ray begins inside the box

    let startsOutside = false;
    let inside = false;
    let startLocation = xy(ray.origin);
    
    ///////////////////////////////

    if (! inside) {
        // The ray is starting outside of the grid. See if it ever
        // intersects the grid.
        
        // From Listing 1 of "A Ray-Box Intersection Algorithm and Efficient Dynamic Voxel Rendering", jcgt 2018
        const t0 = xy(-ray.origin.x / ray.direction.x, -ray.origin.y / ray.direction.y);
        const t1 = xy((numCells.x * cellSize.x - ray.origin.x) / ray.direction.x,
                      (numCells.y * cellSize.y - ray.origin.y) / ray.direction.y);
        const tmin = min(t0, t1), tmax = max(t0, t1);
        const passesThroughGrid = $Math.max(tmin.x, tmin.y) <= $Math.min(tmax.x, tmax.y);
        
        if (passesThroughGrid) {
            // Back up slightly so that we immediately hit the start location.
            it.enterDistance = $Math.hypot(it.ray.origin.x - startLocation.x,
                                          it.ray.origin.y - startLocation.y) - 0.0001;
            startLocation = xy(it.ray.origin.x + it.ray.direction.x * it.enterDistance,
                               it.ray.origin.y + it.ray.direction.y * it.enterDistance);
            startsOutside = true;
        } else {
            // The ray never hits the grid
            it.insideGrid = false;
        }
    }

    //////////////////////////////////////////////////////////////////////
    // Find the per-iteration variables
    const axisArray = 'xy';
        
    for (let i = 0; i < 2; ++i) {
        const a = axisArray[i];
        
        it.index[a]  = $Math.floor(startLocation[a] / cellSize[a]);
        it.tDelta[a] = $Math.abs(cellSize[a] / it.ray.direction[a]);
        it.step[a]   = $Math.sign(it.ray.direction[a]);

        // Distance to the edge fo the cell along the ray direction
        let d = startLocation[a] - it.index[a] * cellSize[a];
        if (it.step[a] > 0) {
            // Measure from the other edge
            d = cellSize[a] - d;

            // Exit on the high side
            it.boundaryIndex[a] = it.numCells[a];
        } else {
            // Exit on the low side (or never)
            it.boundaryIndex[a] = -1;
        }
        $console.assert(d >= 0 && d <= cellSize[a]);

        if (it.ray.direction[a] !== 0) {
            it.exitDistance[a] = d / $Math.abs(it.ray.direction[a]) + it.enterDistance;
        } else {
            // Ray is parallel to this partition axis.
            // Avoid dividing by zero, which could be NaN if d === 0
            it.exitDistance[a] = Infinity;
        }
    }

    /*
    if (gridOriginIndex.x !== 0 || gridOriginIndex.y !== 0) {
        // Offset the grid coordinates
        it.boundaryIndex.x += gridOriginIndex.x;
        it.boundaryIndex.y += gridOriginIndex.y;
        it.index.x         += gridOriginIndex.x;
        it.index.y         += gridOriginIndex.y;
        }
    */

    if (startsOutside) {
        // Let the increment operator bring us into the first cell
        // so that the starting axis is initialized correctly.
        _advanceRayGridIterator(it);
    }
}


function _advanceRayGridIterator(it) {
    // Find the axis of the closest partition along the ray
    it.enterAxis = (it.exitDistance.x < it.exitDistance.y) ? 'x' : 'y';
    
    it.enterDistance              = it.exitDistance[it.enterAxis];
    it.index[it.enterAxis]        += it.step[it.enterAxis];
    it.exitDistance[it.enterAxis] += it.tDelta[it.enterAxis];
    
    // If the index just hit the boundary exit, we have
    // permanently exited the grid.
    it.insideGrid = it.insideGrid && (it.index[it.enterAxis] !== it.boundaryIndex[it.enterAxis]);
    
    it.containsRayOrigin = false;
}


/*
function ray_intersectMap(ray, map, tileCanBeSolid, pixelIsSolid, layer, replacement_array) {
    if (arguments.length === 1 && ray && ray.ray) {
        pixelIsSolid = ray.pixelIsSolid;
        tileCanBeSolid = ray.tileCanBeSolid;
        layer = ray.layer;
        replacement_array = ray.replacement_array;
        map = ray.map;
        ray = ray.ray;
    }

    layer = layer || 0;
    tileCanBeSolid = tileCanBeSolid || get_map_sprite;

    // Default to an infinite ray
    if (ray.length === undefined) {
        ray.length = Infinity;
    }

    // Normalize the direction
    {
        const inv = 1 / $Math.hypot(ray.direction.x, ray.direction.y);
        ray.direction.x *= inv; ray.direction.y *= inv;
    }


    const normal = xy(0, 0);
    const point = xy(0, 0);
    const P = xy(0, 0);
    for (const it = _makeRayGridIterator(ray, map.size, map.sprite_size);
         it.insideGrid && (it.enterDistance < it.ray.length);
         _advanceRayGridIterator(it)) {
        
        // Draw coord normal along which we entered this cell
        normal.x = normal.y = 0;
        normal[it.enterAxis] = -it.step[it.enterAxis];

        // Draw coord point at which we entered the cell
        point.x = it.ray.origin.x + it.enterDistance * it.ray.direction.x;
        point.y = it.ray.origin.y + it.enterDistance * it.ray.direction.y;

        // Bump into the cell and then round
        P.x = $Math.floor((point.x - normal.x) / map.sprite_size.x);
        P.y = $Math.floor((point.y - normal.y) / map.sprite_size.y);
        
        if (tileCanBeSolid(map, P, layer, replacement_array)) {

            // Return the sprite and modify the ray
            ray.length = it.enterDistance;
            return map.layer[layer][P.x][P.y];
            
            // TODO: March the pixels with a second iterator
            // if (! pixelIsSolid || pixelIsSolid(map, P, layer, replacement_array)) {
                // This is a hit
            // }
        }
        
    }  // while

    return undefined;
}
*/

function ray_intersect(ray, obj) {
    let hitObj = undefined;
    if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; ++i) {
            hitObj = ray_intersect(ray, obj[i]) || hitObj;
        }
        return hitObj;
    }

    // Default to an infinite ray
    if (ray.length === undefined) {
        ray.length = Infinity;
    }

    const scaleX = obj.scale ? obj.scale.x : 1;
    const scaleY = obj.scale ? obj.scale.y : 1;

    const pos = _maybeApplyPivot(obj.pos, obj.pivot, obj.angle, obj.scale);
    
    if (obj.size) {
        // Normalize the direction
        let inv = 1 / $Math.hypot(ray.direction.x, ray.direction.y);
        ray.direction.x *= inv; ray.direction.y *= inv;
        
        if (obj.shape === 'disk') {
            // ray-disk (https://www.geometrictools.com/Documentation/IntersectionLine2Circle2.pdf)
            let dx = ray.origin.x - pos.x, dy = ray.origin.y - pos.y;
            if (dx * dx + dy * dy * 4 <= $Math.abs(obj.size.x * obj.size.y * scaleX * scaleY)) {
                // Origin is inside the disk, so instant hit and no need
                // to look at children
                ray.length = 0;
                return obj;
            } else {
                // Origin is outside of the disk.
                const b = ray.direction.x * dx + ray.direction.y * dy
                const discrim = b*b - (dx*dx + dy*dy - 0.25 * obj.size.x * obj.size.y * scaleX * scaleY);
                if (discrim >= 0) {
                    const a = $Math.sqrt(discrim);
                    
                    // Start with the smaller root
                    let t = -b - a;
                    if (t < 0) {
                        // Try the larger root
                        t = -b + a;
                    }
                    
                    if ((t >= 0) && (t < ray.length)) {
                        hitObj = obj;
                        ray.length = t;
                    }
                }            
            }
        } else {
            // Move to the box's translational frame
            let toriginX = ray.origin.x - pos.x;
            let toriginY = ray.origin.y - pos.y;
            
            // Take the ray into the box's rotational frame
            const angle = (obj.angle || 0) * rotation_sign();
            const c = $Math.cos(angle), s = $Math.sin(angle);

            const originX = toriginX * c + toriginY * s;
            const originY =-toriginX * s + toriginY * c;

            const directionX = ray.direction.x * c + ray.direction.y * s;
            const directionY =-ray.direction.x * s + ray.direction.y * c;

            const radX = obj.size.x * 0.5 * scaleX;
            const radY = obj.size.y * 0.5 * scaleY;

            // Perform ray vs. oriented box intersection
            // (http://jcgt.org/published/0007/03/04/)

            const winding = ($Math.max(abs(originX / radX),
                                      abs(originY / radY)) < 1.0) ? -1 : 1;

            const sgnX = -$Math.sign(directionX);
            const sgnY = -$Math.sign(directionY);
            
            // Distance to edge lines
            const dX = (radX * winding * sgnX - originX) / directionX;
            const dY = (radY * winding * sgnY - originY) / directionY;

            const testX = (dX >= 0) && ($Math.abs(originY + directionY * dX) < radY);
            const testY = (dY >= 0) && ($Math.abs(originX + directionX * dY) < radX);

            if (testX) {
                if (dX < ray.length) {
                    ray.length = dX;
                    hitObj = obj;
                }
            } else if (testY && (dY < ray.length)) {
                ray.length = dY;
                hitObj = obj;
            }
        }
    }

    // Test children
    if (obj.child_array) {
        hitObj = ray_intersect(ray, obj.child_array) || hitObj;
    }

    return hitObj;
}


function entity_inertia(entity, mass) {
    const scaleX = entity.scale ? entity.scale.x : 1;
    const scaleY = entity.scale ? entity.scale.y : 1;
    
    // Inertia tensor about the center (https://en.wikipedia.org/wiki/List_of_moments_of_inertia)
    // rect: 1/12 * m * (w^2 + h^2)
    // disk: m * (w/2)^2
    if (mass === undefined) { mass = entity_mass(entity); }
    
    if (entity.shape === 'rect') {
        return mass * (_square(entity.size.x * scaleX) + _square(entity.size.y * scaleY)) * (1 / 12);
    } else {
        return mass * _square(entity.scale.x * scaleX * 0.5);
    }
}


function entity_mass(entity) {
    return entity_area(entity) * ((entity.density !== undefined) ? entity.density : 1);
}


function entity_area(entity) {
    const scaleX = entity.scale ? entity.scale.x : 1;
    const scaleY = entity.scale ? entity.scale.y : 1;

    if (entity.size === undefined) {
        return 0;
    } else if (entity.shape === 'disk') {
        return $Math.abs($Math.PI * 0.25 * scaleX * scaleY * entity.size.x * entity.size.y);
    } else {
        return $Math.abs(scaleX * scaleY * entity.size.x * entity.size.y);
    }
}


// Add any default fields needed for an overlaps() test and return the cleaned up object.
function _cleanupRegion(A) {
    if ((A.scale === undefined) || (A.pos === undefined) || (A.shape === undefined) || (A.size === undefined)) {
        if ((A.x !== undefined) && (A.y !== undefined)) {
            // This is a point. Default to disk because it makes
            // collision tests simpler.
            A = {pos:A, shape: 'disk'};
        }
        
        // Make a new object with default properties
        A = Object.assign({scale: xy(1, 1), size: xy(0, 0), angle: 0, shape: 'rect'}, A);
    }
    
    if (A.pivot && (A.pivot.x !== 0 || A.pivot.y !== 0)) {
        // Apply the pivot, cloning the entire object for simplicity
        A = Object.assign({}, A);
        A.pos = _maybeApplyPivot(A.pos, A.pivot, A.angle, A.scale);
        A.pivot = undefined;
    }
    
    // All required properties are present
    return A;
}


/** True if the objects overlap. Positions are centers. Sizes are
    width, height vectors.  Angles are counter-clockwise radians from
    +x to +y. Shapes are 'rect' or 'disk'. If 'disk', the size x
    and y must be the same.  */
var overlaps = (function() {

    // Appends e and all of its descendants to output
    function getDescendants(e, output) {
        if (e) {
            output.push(e);
            if (e.child_array) {
                for (let i = 0; i < e.child_array.length; ++i) {
                    getDescendants(e.child_array[i], output);
                }
            }
        }
    }
    
    function distanceSquared2D(u, v) { return _square(u.x - v.x) + _square(u.y - v.y); }

    // Scratch space vector to avoid memory allocation
    const temp = {x:0, y:0};
    const temp2 = {x:0, y:0};

    // From http://www.flipcode.com/archives/2D_OBB_Intersection.shtml
    function obbOverlapOneWay(A, B, offsetX, offsetY) {
        // Transform B in to A's reference frame and then use the
        // separating axis test.  Try to find an axis along which
        // the projection of B onto A does not overlap

        temp2.x = B.pos.x - offsetX;
        temp2.y = B.pos.y - offsetY;
        const center = _toFrame(A, temp2, temp);
        const angle  = (B.angle - A.angle) * rotation_sign();

        // Find the extremes of the corners of B along each axis of A
        const c = $Math.cos(angle);
        const s = $Math.sin(angle);

        let loX =  Infinity, loY =  Infinity;
        var hiX = -Infinity, hiY = -Infinity;

        // Four corners = four combinations of signs. Expand out the
        // vector operations to avoid memory allocation.
        for (let signX = -1; signX <= +1; signX += 2) {
            for (let signY = -1; signY <= +1; signY += 2) {
                const xx = signX * B.size.x * 0.5 * $Math.abs(B.scale.x);
                const yy = signY * B.size.y * 0.5 * $Math.abs(B.scale.y);
                const cornerX = xx *  c + yy * s;
                const cornerY = xx * -s + yy * c;

                loX = $Math.min(loX, cornerX);
                loY = $Math.min(loY, cornerY);

                hiX = $Math.max(hiX, cornerX);
                hiY = $Math.max(hiY, cornerY);
            }
        }

        loX += center.x;
        loY += center.y;
        hiX += center.x;
        hiY += center.y;
        
        // We can now perform an AABB test to see if there is no separating
        // axis under this projection
        return ((loX * 2 <= A.size.x * $Math.abs(A.scale.x)) && (hiX * 2 >= -A.size.x * $Math.abs(A.scale.x)) &&
                (loY * 2 <= A.size.y * $Math.abs(A.scale.y)) && (hiY * 2 >= -A.size.y * $Math.abs(A.scale.y)));
    }

    return function(A, B, recurse) {
        if (A === undefined) { throw new Error('First argument to overlaps() must not be nil'); }
        if (B === undefined) { throw new Error('Second argument to overlaps() must not be nil'); }
        
        if (((recurse === undefined) || recurse) &&
            ((A.child_array && (A.child_array.length > 0)) ||
             (B.child_array && (B.child_array.length > 0)))) {

            // Handle all combinations of chidren here
            const AArray = [], BArray = [];
            getDescendants(A, AArray);
            getDescendants(B, BArray);
            for (let i = 0; i < AArray.length; ++i) {
                for (let j = 0; j < BArray.length; ++j) {
                    if (overlaps(AArray[i], BArray[j], false)) {
                        return true;
                    }
                }
            }
            return false;
        }

        A = _cleanupRegion(A); B = _cleanupRegion(B);

        // For future use offsetting object B, which is convenient for speculative
        // collision detection but not supported in the current implementation.
        let offsetX = 0, offsetY = 0;
        
        if (A.shape === 'disk') {
            // Swap the objects so that the rect is first, if
            // there is one
            const swap = A; A = B; B = swap;
            offsetX = -offsetX; offsetY = -offsetY;
        }
        
        // The position of object 2
        temp2.x = B.pos.x - offsetX;
        temp2.y = B.pos.y - offsetY;

        // If there is any rect, it is now entity A

        if (A.shape === 'disk') {
            
            // Disk-Disk. Multiply the right-hand side by 4 because
            // we're computing diameter^2 instead of radius^2
            return distanceSquared2D(A.pos, temp2) * 4 <= _square(A.size.x * $Math.abs(A.scale.x) + B.size.x * $Math.abs(B.scale.x));

        } else if ((B.size.x === 0) && (B.size.y === 0) && (A.angle === 0)) {

            // Trivial axis-aligned test against a rectangle
            return ($Math.abs(B.pos.x - A.pos.x) * 2 <= $Math.abs(A.size.x * A.scale.x) &&
                    $Math.abs(B.pos.y - A.pos.y) * 2 <= $Math.abs(A.size.y * A.scale.y));
    
        } else if (B.shape === 'disk') {
            // Box A vs. Disk B 
            
            // Algorithm derivation:
            // http://stackoverflow.com/questions/401847/circle-rectangle-collision-detection-intersection
            
            // Compute the position of the center of disk B in the
            // object space of box A.  Exploit symmetry in object
            // space by moving to the first quadrant. Then, make P
            // twice as big so that we can compare to diameters
            // instead of radii below.
            const P = _toFrame(A, temp2, temp);
            P.x = 2 * $Math.abs(P.x); P.y = 2 * $Math.abs(P.y);
            
            if ((P.x > A.size.x * $Math.abs(A.scale.x) + B.size.x * $Math.abs(B.scale.x)) || (P.y > A.size.y * $Math.abs(A.scale.y) + B.size.y * $Math.abs(B.scale.y))) {
                // Trivially outside by box-box overlap test
                return false;
            } else if ((P.x <= A.size.x * $Math.abs(A.scale.x)) || (P.y <= A.size.y * $Math.abs(A.scale.y))) {
                // Trivially inside because the center of disk B is
                // inside the perimeter of box A. Note that we tested
                // twice the absolute position against twice the
                // radius.
                return true;
            } else {
                // Must be in the "corner" case. Note that these
                // squared expressions are all implicitly multipled
                // by four because of the use of diameters instead of
                // radii.

                temp2.x = A.size.x * $Math.abs(A.scale.x);
                temp2.y = A.size.y * $Math.abs(A.scale.y);
                return distanceSquared2D(P, temp2) <= _square(B.size.x * B.scale.x);
            }       
            
        } else if ((A.angle === 0) && (B.angle === 0)) {
            
            // Axis-aligned Box-Box: 2D interval overlap
            return (($Math.abs(A.pos.x - temp2.x) * 2 <= ($Math.abs(A.size.x * A.scale.x) + $Math.abs(B.size.x * B.scale.x))) &&
                    ($Math.abs(A.pos.y - temp2.y) * 2 <= ($Math.abs(A.size.y * A.scale.x) + $Math.abs(B.size.y * B.scale.x))));
        
        } else {
            
            // Oriented Box-box (http://www.flipcode.com/archives/2D_OBB_Intersection.shtml)
            return obbOverlapOneWay(A, B, offsetX, offsetY) && obbOverlapOneWay(B, A, -offsetX, -offsetY);
            
        }
    };
})();


function set_pause_menu(...options) {
    if (options.length > 3) { $error("At most three custom menu options are supported."); }
    for (let i = 0; i < options.length; ++i) {
        if (options[i].text === undefined) {
            $error('set_pause_menu() options must be objects with text properties');
        }
    }
    $customPauseMenuOptions = clone(options);
}


function any_button_press(gamepad) {
    if (gamepad === undefined) {
        return any_button_press(gamepad_array[0]) || any_button_press(gamepad_array[1]) || any_button_press(gamepad_array[2]) || any_button_press(gamepad_array[3]) || touch.aa;
    } else {
        return gamepad.aa || gamepad.bb || gamepad.cc || gamepad.dd || gamepad.ee || gamepad.ff || gamepad.qq;
    }
}


function any_button_release(gamepad) {
    if (gamepad === undefined) {
        return any_button_release(gamepad_array[0]) || any_button_release(gamepad_array[1]) || any_button_release(gamepad_array[2]) || any_button_release(gamepad_array[3]) || touch.released_a;
    } else {
        return gamepad.released_a || gamepad.released_b || gamepad.released_c || gamepad.released_d || gamepad.released_e || gamepad.released_f || gamepad.released_q;
    }
}


function random_truncated_gaussian(mean, std, radius, rng) {
    rng = rng || random;
    var g = 0;
    do {
        g = random_gaussian(mean, std, rng);
    } while (g < mean - radius || g > mean + radius);
    return g;
}


function random_truncated_gaussian2D(mean, std, radius, rng) {
    rng = rng || random;
    if (radius === undefined) {
        throw Error("random_truncated_gaussian2D(mean, stddev, radius, random) requires 3 or 4 arguments.");
    }

    if (is_number(std)) { std = {x: std, y: std}; }
    if (is_number(mean)) { mean = {x: mean, y: mean}; }
    if (is_number(radius)) { radius = {x: radius, y: radius}; }

    var X = std.x / radius.x;
    var Y = std.y / radius.y;
    var r;
    do {
        r = rng();
        if (r > 0) {
            r = $Math.sqrt(-2 * $Math.log(r));
        }
    } while (square(r * X) + square(r * Y) > 1);
    var q = rng(0, 2 * $Math.PI);
    var g1 = r * $Math.cos(q);
    var g2 = r * $Math.sin(q);
    return {x: g1 * std.x + mean.x, y: g2 * std.y + mean.y};
}


function random_gaussian(mean, std, rng) {
    rng = rng || random;
    if (std === undefined) {
        if (mean !== undefined) {
            throw Error("random_gaussian(mean, stddev, random) requires 0, 2, or 3 arguments.");
        }
        std = 1;
        mean = 0;
    }
    var r = rng();
    if (r > 0) {
        r = $Math.sqrt(-2 * $Math.log(r));
    }
    var q = rng(0, 2 * $Math.PI);
    var g1 = r * $Math.cos(q);
    return g1 * std + mean;    
}

function random_gaussian3D(mean, std, rng) {
    rng = rng || random;
    if (std === undefined) {
        if (mean !== undefined) {
            throw Error("random_gaussian3D(mean, stddev, random) requires 0, 2, or 3 arguments.");
        }
        std = {x: 1, y: 1, z: 1};
        mean = {x: 0, y: 0, z: 0};
    }
    if (is_number(std)) { std = {x: std, y: std, z: std}; }
    if (is_number(mean)) { mean = {x: mean, y: mean, z: mean}; }
    var g = random_gaussian2D(mean, std, rng);
    g.z = random_gaussian(mean.z, std.z, rng);
    return g;
}

function random_truncated_gaussian3D(mean, std, radius, rng) {
    rng = rng || random;
    if (radius === undefined) {
        throw Error("random_truncated_gaussian3D(mean, stddev, radius, random) requires 3 or 4 arguments.");
    }
    if (is_number(std)) { std = {x: std, y: std, z: std}; }
    if (is_number(mean)) { mean = {x: mean, y: mean, z: mean}; }
    if (is_number(radius)) { mean = {x: radius, y: radius, z: radius}; }

    var center = {x: 0, y: 0, z: 0};
    var g;

    do {
        g = {x: random_gaussian(0, std.x, rng),
             y: random_gaussian(0, std.y, rng),
             z: random_gaussian(0, std.z, rng)};
    } while (square(g.x / radius.x) + square(g.y / radius.y) + square(g.z / radius.z) > 1);
    
    return {x: g.x + mean.x, y: g.y + mean.y, z: g.z + mean.z};
}


function random_gaussian2D(mean, std, rng) {
    rng = rng || random;
    if (std === undefined) {
        if (mean !== undefined) {
            throw Error("random_gaussian2D(mean, stddev, random) requires 0, 2, or 3 arguments.");
        }
        std = {x: 1, y: 1};
        mean = {x: 0, y: 0};
    }

    if (is_number(std)) { std = {x: std, y: std}; }
    if (is_number(mean)) { mean = {x: mean, y: mean}; }
    
    var r = rng();
    if (r > 0) {
        r = $Math.sqrt(-2 * $Math.log(r));
    }
    var q = rng(0, 2 * $Math.PI);
    var g1 = r * $Math.cos(q);
    var g2 = r * $Math.sin(q);
    return {x: g1 * std.x + mean.x, y: g2 * std.y + mean.y};
}

function random_within_square(rng) {
    rng = rng || random;
    return {x: rng(-1, 1), y: rng(-1, 1)};
}

function random_within_cube(rng) {
    rng = rng || random;
    return {x: rng(-1, 1), y: rng(-1, 1), z: rng(-1, 1)};
}

function random_sign(rng) {
    rng = rng || random;
    return (rng() < 0.5) ? -1 : +1;
}

function random_on_square(rng) {
    rng = rng || random;
    if (rng() < 0.5) {
        return {x: random_sign(), y: rng(-1, 1)};
    } else {
        return {x: rng(-1, 1), y: random_sign()};
    }
}

function random_on_cube(rng) {
    rng = rng || random;
    var r = rng() < 1/3;
    if (r < 1/3) {
        return {x: random_sign(), y: rng(-1, 1), z: rng(-1, 1)};
    } else if (r < 2/3) {
        return {x: rng(-1, 1), y: random_sign(), z: rng(-1, 1)};
    } else {
        return {x: rng(-1, 1), y: rng(-1, 1), z: random_sign()};
    }
}

function random_on_sphere(rng) {
    rng = rng || random;
    const a = $Math.acos(rng(-1, 1)) - $Math.PI / 2;
    const b = rng(0, $Math.PI * 2);
    const c = $Math.cos(a);
    return {x: c * $Math.cos(b), y: c * $Math.sin(b), z: $Math.sin(a)};
}

var random_direction3D = random_on_sphere;

function random_on_circle() {
    const t = random() * 2 * $Math.PI;
    return {x: $Math.cos(t), y: $Math.sin(t)};
}

var random_direction2D = random_on_circle;

function random_within_circle(rng) {
    rng = rng || random;
    const P = {x:0, y:0}
    let m = 0;
    do {
        P.x = rng(-1, 1);
        P.y = rng(-1, 1);
        m = P.x * P.x + P.y * P.y;
    } while (m > 1);
    m = 1 / m;
    P.x *= m; P.y *= m;
    return P;
}


function random_within_sphere(rng) {
    rng = rng || random;
    const P = {x:0, y:0, z:0}
    let m = 0;
    do {
        P.x = rng(-1, 1);
        P.y = rng(-1, 1);
        P.z = rng(-1, 1);
        m = P.x * P.x + P.y * P.y + P.z * P.z;
    } while (m > 1);
    m = 1 / m;
    P.x *= m; P.y *= m; P.z *= m;
    return P;
}


function _makeRng(seed) {
    /* Based on https://github.com/AndreasMadsen/xorshift/blob/master/xorshift.js

       Copyright (c) 2014 Andreas Madsen & Emil Bay

       Permission is hereby granted, free of charge, to any person obtaining a copy of this
       software and associated documentation files (the "Software"), to deal in the Software
       without restriction, including without limitation the rights to use, copy, modify,
       merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
       permit persons to whom the Software is furnished to do so, subject to the following
       conditions:

       The above copyright notice and this permission notice shall be included in all copies or
       substantial portions of the Software.

       THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
       INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
       PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
       LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT
       OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
       OTHER DEALINGS IN THE SOFTWARE.
    */
    
    var state0U = 5662365, state0L = 20000, state1U = 30000, state1L = 4095;

    function set_random_seed(seed) {
        if (seed === undefined || seed === 0) { seed = 4.7499362e+13; }
        if (seed < 2**16) { seed += seed * 1.3529423483002e15; }
        state0U = $Math.abs(seed / 2**24) >>> 0;

        // Avoid all zeros
        if (state0U === 0) { state0U = 5662365; }
        
        state0L = $Math.abs(seed) >>> 0;
        state1U = $Math.abs(seed / 2**16) >>> 0;
        state1L = $Math.abs(seed / 2**32) >>> 0;
        //$console.log(seed, state0U, state0L, state1U, state1L)
    }

    if (seed !== undefined) {
        set_random_seed(seed);
    }

    function random(lo, hi) {
        // uint64_t s1 = s[0]
        var s1U = state0U, s1L = state0L;
        // uint64_t s0 = s[1]
        var s0U = state1U, s0L = state1L;

        // result = s0 + s1
        var sumL = (s0L >>> 0) + (s1L >>> 0);
        var resU = (s0U + s1U + (sumL / 2 >>> 31)) >>> 0;
        var resL = sumL >>> 0;
        
        // s[0] = s0
        state0U = s0U;
        state0L = s0L;
        
        // - t1 = [0, 0]
        var t1U = 0, t1L = 0;
        // - t2 = [0, 0]
        var t2U = 0, t2L = 0;
        
        // s1 ^= s1 << 23;
        // :: t1 = s1 << 23
        var a1 = 23;
        var m1 = 0xFFFFFFFF << (32 - a1);
        t1U = (s1U << a1) | ((s1L & m1) >>> (32 - a1));
        t1L = s1L << a1;
        // :: s1 = s1 ^ t1
        s1U = s1U ^ t1U;
        s1L = s1L ^ t1L;
        
        // t1 = ( s1 ^ s0 ^ ( s1 >> 17 ) ^ ( s0 >> 26 ) )
        // :: t1 = s1 ^ s0
        t1U = s1U ^ s0U;
        t1L = s1L ^ s0L;
        // :: t2 = s1 >> 18
        var a2 = 18;
        var m2 = 0xFFFFFFFF >>> (32 - a2);
        t2U = s1U >>> a2;
        t2L = (s1L >>> a2) | ((s1U & m2) << (32 - a2));
        // :: t1 = t1 ^ t2
        t1U = t1U ^ t2U;
        t1L = t1L ^ t2L;
        // :: t2 = s0 >> 5
        var a3 = 5;
        var m3 = 0xFFFFFFFF >>> (32 - a3);
        t2U = s0U >>> a3;
        t2L = (s0L >>> a3) | ((s0U & m3) << (32 - a3));
        // :: t1 = t1 ^ t2
        t1U = t1U ^ t2U;
        t1L = t1L ^ t2L;
        
        // s[1] = t1
        state1U = t1U;
        state1L = t1L;
        
        var r = resU * 2.3283064365386963e-10 + (resL >>> 12) * 2.220446049250313e-16;
        if (hi === undefined) {
            if (lo === undefined) {
                return r;
            } else {
                throw new Error("Use random() or random(lo, hi). A single argument is not supported.");
            }
        } else {
            return r * (hi - lo) + lo;
        }
    }

    return [random, set_random_seed];
}
        
var [random, set_random_seed] = _makeRng();

function make_random(seed) {
    var [random, set_random_seed] = _makeRng(seed || (local_time().millisecond() * 1e6));
    return random;
}

function random_integer(lo, hi, rng) {
    if (hi === undefined) {
        if (lo === undefined) {
            throw new Error("random_integer(lo, hi, random = random) requires at least two arguments.");
        }
        // Backwards compatibility
        hi = lo;
        lo = 0;        
    }
    rng = rng || random;
    var n = hi - lo + 1;
    return $Math.min(hi, floor(rng(lo, hi + 1)));
}


// Calls to mutate are emitted by mutating operator processing, for example +=.
// This is use to avoid double-evaluation of r-values.
function _mutate(obj, key, op, val) {
    return obj[key] = op(obj[key], val);
}

//////////////////////////////////////////////////////////////////////////////

// Note that add includes concatenation
function _add(a, b) {
    // Keep short to encourage inlining
    return ((typeof a === 'object') && (a !== null)) ? _objectAdd(a, b) : a + b;
}

function _addMutate(a, b) {
    return ((typeof a === 'object') && (a !== null)) ? _objectAddMutate(a, b) : a += b;
}

function _objectAdd(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) { $error('Cannot use + with arrays'); }
    
    // clone, preserving prototype
    const c = a.constructor ? a.constructor() : $Object.create(null);

    // avoid hasOwnProperty for speed
    if (typeof b === 'object') for (const key in a) c[key] = a[key] + b[key];
    else                       for (const key in a) c[key] = a[key] + b;
    
    return c;
}

function _objectAddMutate(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) { $error('Cannot use += with arrays'); }
    
    if (typeof b === 'object') for (let key in a) a[key] += b[key];
    else                       for (let key in a) a[key] += b;
    return a;
}

/////////////////////////////////////////////////////////////////////////////

function _neg(a) {
    return ((typeof a === 'object') && (a !== null)) ? _objectNeg(a) : -a;
}

function _objectNeg(a) {
    if (Array.isArray(a)) { $error('Cannot use - with arrays'); }
    let c = a.constructor ? a.constructor() : $Object.create(null);
    for (let key in a) c[key] = -a[key];
    return c;
}

/////////////////////////////////////////////////////////////////////////////

function _sub(a, b) {
    return ((typeof a === 'object') && (a !== null)) ? _objectSub(a, b) : a - b;
}

function _subMutate(a, b) {
    return ((typeof a === 'object') && (a !== null)) ? _objectSubMutate(a, b) : a -= b;
}

function _objectSub(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) { $error('Cannot use - with arrays'); }
    const c = a.constructor ? a.constructor() : $Object.create(null);
    
    if (typeof b === 'object') for (const key in a) c[key] = a[key] - b[key];
    else                       for (const key in a) c[key] = a[key] - b;
    
    return c;
}

function _objectSubMutate(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) { $error('Cannot use -= with arrays'); }
    if (typeof b === 'object') for (const key in a) a[key] -= b[key];
    else                       for (const key in a) a[key] -= b;
    return a;
}

/////////////////////////////////////////////////////////////////////////////

function _div(a, b) {
    return ((typeof a === 'object') && (a !== null)) ? _objectDiv(a, b) : a / b;
}

function _divMutate(a, b) {
    return ((typeof a === 'object') && (a !== null)) ? _objectDivMutate(a, b) : a /= b;
}

function _objectDiv(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) { $error('Cannot use / with arrays'); }    
    const c = a.constructor ? a.constructor() : $Object.create(null);

    if (typeof b === 'object') for (const key in a) c[key] = a[key] / b[key];
    else {
        b = 1 / b;
        for (const key in a) c[key] = a[key] * b;
    }
    
    return c;
}

function _objectDivMutate(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) { $error('Cannot use /= with arrays'); }    
    if (typeof b === 'object') for (const key in a) a[key] /= b[key];
    else {
        b = 1 / b;
        for (const key in a) a[key] *= b;
    }
    return a;
}

/////////////////////////////////////////////////////////////////////////////

function _mul(a, b) {
    // Special case: allow number * object
    return ((typeof a === 'object') && (a !== null)) ?
        _objectMul(a, b) :
        ((typeof b === 'object') && (b !== null)) ?
        _objectMul(b, a) :
        a * b;
}

function _mulMutate(a, b) {
    return ((typeof a === 'object') && (a !== null)) ? _objectMulMutate(a, b) : a *= b;
}

function _objectMul(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) { $error('Cannot use * with arrays'); }    
    const c = a.constructor ? a.constructor() : $Object.create(null);

    if (typeof b === 'object') for (const key in a) c[key] = a[key] * b[key];
    else                       for (const key in a) c[key] = a[key] * b;
    
    return c;
}

function _objectMulMutate(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) { $error('Cannot use *= with arrays'); }    
    if (typeof b === 'object') for (const key in a) a[key] *= b[key];
    else                       for (const key in a) a[key] *= b;
    return a;
}

/////////////////////////////////////////////////////////////////////////////

// vector operators:

function abs(a) {
    if (typeof a === 'object') {
        let c = a.constructor ? a.constructor() : $Object.create(null);
        for (let key in a) c[key] = $Math.abs(a[key]);
        return c;
    } else {
        return $Math.abs(a);
    }
}

function floor(a, u) {
    if (typeof a === 'object') {
        const c = a.constructor ? a.constructor() : $Object.create(null);

        if (u === undefined) {
            for (let key in a) c[key] = $Math.floor(a[key]);
        } else {
            for (let key in a) c[key] = $Math.floor(a[key] / u) * u;
        }
        return c;
    } else if (u === undefined) {
        return $Math.floor(a);
    } else {
        return $Math.floor(a / u) * u;
    }
}


function ceil(a, u) {
    if (typeof a === 'object') {
        const c = a.constructor ? a.constructor() : $Object.create(null);
        if (u === undefined) {
            for (let key in a) c[key] = $Math.ceil(a[key]);
        } else {
            for (let key in a) c[key] = $Math.ceil(a[key] / u) * u;
        }
        return c;
    } else if (u === undefined) {
        return $Math.ceil(a);
    } else {
        return $Math.ceil(a / u) * u;
    }
}


function round(a, unit) {
    if (typeof a === 'object') {
        unit = unit || 1;
        const invUnit = 1 / unit;
        const c = a.constructor ? a.constructor() : $Object.create(null);
        for (let key in a) c[key] = $Math.round(a[key] * invUnit) * unit;
        return c;
    } else if (unit) {
        return $Math.round(a / unit) * unit;
    } else  {
        return $Math.round(a);
    }
}

function trunc(a) {
    if (typeof a === 'object') {
        let c = a.constructor ? a.constructor() : $Object.create(null);
        for (let key in a) c[key] = $Math.trunc(a[key]);
        return c;
    } else {
        return $Math.trunc(a);
    }
}

function sign(a) {
    if (typeof a === 'object') {
        let c = a.constructor ? a.constructor() : $Object.create(null);
        for (let key in a) c[key] = $Math.sign(a[key]);
        return c;
    } else {
        return $Math.sign(a);
    }
}


function is_array(a) {
    return Array.isArray(a);
}


function is_function(a) {
    return typeof a === 'function';
}


function is_nil(a) {
    return (a === undefined) || (a === null);
}

function is_number(a) {
    return typeof a === 'number';
}


function is_boolean(a) {
    return typeof a === 'boolean';
}


function is_string(a) {
    return typeof a === 'string';
}


function type(a) {
    if (is_array(a)) {
        return 'array';
    } else if (is_nil(a)) {
        return 'nil';
    } else {
        return typeof a;
    }
}


function is_object(a) {
    return ! is_array(a) && (typeof a === 'object');
}


function clone(a) {
    if (! a || (a._type !== undefined && a._type !== 'map')) {
        // Built-in that is not a map; maps are treated
        // specially as an only partly-immutable asset.
        return a;
    } else if (a._type === 'map') {
        // Maps are a special case, where we want the full layer
        // structure and arrays preserved when cloning, instead of
        // pointers.
        return deep_clone(a);
    } else if (typeof a === 'object') {
        // Includes arrays; we have to copy the non-indexed properties,
        // so we treat them as objects.
        const c = a.constructor ? a.constructor() : $Object.create(null);
        return $Object.assign(c, a);
    } else {
        return a;
    }
}


// The "map" argument is a map from original object pointers to their
// existing clones during this particular cloning.
//
// The is_map_asset argument refers to whether the 'a' argument is
// an asset that is a game map, or is a part of a game map, which
// is a special case for the sealing and finalization rules.
function _deep_clone(a, map, is_map_asset) {
    if (! a || (a._type !== undefined && a._type !== 'map')) {
        // Built-in; return directly instead of cloning since it is
        // immutable (this is based on the assumption that quadplay
        // makes frozen recursive, which it does).
        return a;
    } else if (Array.isArray(a)) {
        let x = map.get(a);
        if (x !== undefined) {
            // Already cloned
            return x;
        } else {
            // Clone the array structure and store the new value in
            // the memoization map
            map.set(a, x = a.slice(0));

            if (is_map_asset === undefined) {
                is_map_asset = (a._type === 'map');
            }

            // Clone array elements
            for (let i = 0; i < x.length; ++i) {
                x[i] = _deep_clone(x[i], map, is_map_asset);
            }
            
            // Clone all non-Array properties that might have been
            // added to this array.  They are distinguished by
            // names that are not numbers.
            const k = $Object.keys(a);
            for (let i = 0; i < k.length; ++i) {
                const key = k[i];
                if (key[0] > '9' || key[0] < '0') {
                    if ((key === '_name') && (a._name[0] !== '«')) {
                        x[key] = '«cloned ' + a._name + '»';
                    } else {
                        x[key] = _deep_clone(a[key], map, is_map_asset);
                    }
                }
            }

            if (is_map_asset) {
                if ($Object.isSealed(a)) { $Object.seal(x); }
                if ($Object.isFrozen(a)) { $Object.freeze(x); }
            }

            return x;
        }
    } else if (typeof a === 'object') {
        $console.assert(a._type === undefined);
        
        let x = map.get(a);
        if (x !== undefined) {
            // Already cloned
            return x;
        } else {
            map.set(a, x = a.constructor ? a.constructor() : $Object.create(null));
            const k = $Object.keys(a);
            for (let i = 0; i < k.length; ++i) {
                const key = k[i];
                if (key === '_name') {
                    if (a._name[0] !== '«') {
                        x._name = '«cloned ' + a._name + '»';
                    } else {
                        x._name = a._name;
                    }
                } else {
                    x[key] = _deep_clone(a[key], map, is_map_asset);
                }
            }
            if (a._name && $Object.isSealed(a)) { $Object.seal(x); }
            return x;
        }
    } else {
        // Other primitive; just return the value
        return a;
    }
}


function deep_clone(a) {
    return _deep_clone(a, new Map());    
}


function copy(s, d) {
    if (Array.isArray(s)) {
        if (! Array.isArray(d)) { throw new Error("Destination must be an array"); }
        d.length = s.length;
        for (let i = 0; i < s.length; ++i) {
            d[i] = s[i];
        }
        return d;
    } else if (typeof s === 'object') {
        if (typeof d !== 'object') { throw new Error("Destination must be an object"); }
        return $Object.assign(d, s);
    } else {
        throw new Error("Not an array or object");
    }
}


function perp(v) {
    if (Array.isArray(v)) {
        return [-v[1], v[0]];
    } else {
        return xy(-v.y, v.x);
    }
}


// Cross product for 3D vectors of the form [x, y, z] or {x:, y:, z:}
// for 2D vectors, returns the z component...determinant of [a;b]
function cross(a, b) {
    if (Array.isArray(a)) {
        if (a.length === 2) {
            return a[0] * b[1] - a[1] * b[0];
        } else {
            let c = a.constructor ? a.constructor() : $Object.create(null);
            c[0] = a[1] * b[2] - a[2] * b[1];
            c[1] = a[2] * b[0] - a[0] * b[2];
            c[2] = a[0] * b[1] - a[1] * b[0];
            return c;
        }
    } else if (a.z === undefined) {
        // 2D
        return a.x * b.y - a.y * b.x;
    } else {
        let c = a.constructor ? a.constructor() : $Object.create(null);
        c.x = a.y * b.z - a.z * b.y;
        c.y = a.z * b.x - a.x * b.z;
        c.z = a.x * b.y - a.y * b.x;
        return c;
    }
}

// Inner product. Always returns a Number.
function dot(a, b) {
    if (typeof a === 'number') { return a * b; }
    let s = 0;
    for (let key in a) s += a[key] * b[key];
    return s;
}

function lowercase(s) {
    return s.toLowerCase();
}

function uppercase(s) {
    return s.toUpperCase();
}


var _superscriptTable = {'0':'⁰', '1':'¹', '2':'²', '3':'³', '4':'⁴', '5':'⁵', '6':'⁶', '7':'⁷', '8':'⁸', '9':'⁹', '+':'', '-':'⁻'};

// Pads to be two digits with zeros
function _padZero(n) {
    n = $Math.min($Math.max(0, $Math.floor(n)), 99);
    if (n < 10) return '0' + n;
    else        return '' + n;
}


var _ordinal = $Object.freeze(['zeroth', 'first', 'second', 'third', 'fourth', 'fifth',
                               'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh',
                               'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth',
                               'seventeenth', 'eighteenth', 'ninteenth', 'twentieth']);
                  
function format_number(n, fmt) {
    if (fmt !== undefined && ! is_string(fmt)) { throw new Error('The format argument to format_number must be a string'); }
    if (! is_number(n)) { throw new Error('The number argument to format_number must be a number'); }
    switch (fmt) {
    case 'percent':
    case '%':
        return $Math.round(n * 100) + '%';
    case 'commas':
    case ',':
        return n.toLocaleString('en');
    case 'spaces':
        return n.toLocaleString('fr');
    case 'binary':
        return '0b' + n.toString(2);
    case 'degrees':
    case '°':
    case 'deg':
        return $Math.round(n * 180 / $Math.PI) + '°';
    case 'hex':
        return '0x' + n.toString(16);
    case 'scientific':
        {
            let x = $Math.floor($Math.log10($Math.abs(n)));
            if ($Math.abs(x) === Infinity) { x = 0; }
            // round to 3 decimal places in scientific notation
            let s = '' + ($Math.round(n * $Math.pow(10, 3 - x)) * 1e-3);
            // If rounding failed due to precision, truncate the
            // string itself
            s = s.substring(0, $Math.min((n < 0) ? 6 : 5), s.length);
            s += '×10';
            const e = '' + x;
            for (let i = 0; i < e.length; ++i) {
                s += _superscriptTable[e.charAt(i)];
            }
            return s;
        }

    case 'clock12':
        {
            n = $Math.round(n / 60);
            const m = n % 60;
            let h = $Math.floor(n / 60);
            const suffix = ((h % 24) < 12) ? 'am' : 'pm';
            h = h % 12;
            if (h === 0) { h = 12; }
            return h + ':' + _padZero(m) + suffix;
        }
    case 'clock24':
        {
            const m = $Math.floor(n / 60) % 60;
            const h = $Math.floor(n / 3600) % 24;
            return h + ':' + _padZero(m);
        }
    case 'stopwatch':
        {
            const m = $Math.floor(n / 60);
            const s = _padZero(n % 60);
            const f = _padZero((n - $Math.floor(n)) * 100);
            return m + ':' + s + '.' + f;
        }
    case 'oldstopwatch':
        {
            const m = $Math.floor(n / 60);
            const s = _padZero(n % 60);
            const f = _padZero((n - $Math.floor(n)) * 100);
            return m + '"' + s + "'" + f;
        }

    case 'ordinalabbrev':
        n = $Math.round(n);
        switch (n) {
        case 1: return '1ˢᵗ';
        case 2: return '2ⁿᵈ';
        case 3: return '3ʳᵈ';
        default: return '' + n + 'ᵗʰ';
        }

    case 'ordinal':
        n = $Math.round(n);
        if (n >= 0 && n < _ordinal.length) {
            return _ordinal[n];
        } else {
            return '' + n + 'ᵗʰ';
        }

    case '':
    case undefined:
        return '' + n;
        
    default:
        {
            const match = fmt.match(/^( *)(0*)(\.0+)?$/);
            if (match) {
                const spaceNum = match[1].length;
                const intNum = match[2].length;
                const fracNum = match[3] ? $Math.max(match[3].length - 1, 0) : 0;

                let s = $Math.abs(n).toFixed(fracNum);

                let i = (fracNum === 0) ? s.length : s.indexOf('.');
                while (i < intNum) { s = '0' + s; ++i; }
                while (i < intNum + spaceNum) { s = ' ' + s; ++i; }
                if (n < 0) { s = '-' + s; }
                return s;
            } else {
                return '' + n;
            }
        }
    }
}


function shuffle(array) {
    if (! Array.isArray(array)) {
        throw new Error('The argument to shuffle() must be an array');
    }
    
    // While there remain elements to shuffle...
    for (let i = array.length - 1; i > 0; --i) {
        // Pick a remaining element...
        let j = random_integer(i - 1);
        
        // ...and swap it with the current element.
        const temp = array[i];
        array[i] = array[j];
        array[j] = temp;
    }
}


function join(array, separator, lastSeparator, lastIfTwoSeparator, empty) {
    if (array.length === 0) {
        return empty || '';
    } else if (lastIfTwoSeparator !== undefined && array.length === 2) {
        return (typeof array[0] === 'string' ? array[0] : unparse(array[0])) + lastIfTwoSeparator +
            (typeof array[1] === 'string' ? array[1] : unparse(array[1]));
    } else {
        separator = separator || '';
        if (lastSeparator === undefined) {
            lastSeparator = separator;
        }
        if (lastIfTwoSeparator === undefined) {
            lastIfTwoSeparator = lastSeparator;
        }
        let s = (typeof array[0] === 'string') ? array[0] : unparse(array[0]);
        for (let i = 1; i < array.length; ++i) {
            let a = array[i];
            if (typeof a !== 'string') {
                a = unparse(a);
            }

            if ((i === array.length - 1) && (lastSeparator !== undefined)) {
                s += lastSeparator + a;
            } else {
                s += separator + a;
            }
        }
        return s;
    }
}


function shuffled(a) {
    if (Array.isArray(a)) {
        const c = clone(a);
        shuffle(c);
        return c;
    } else {
        // String case
        const c = split(a);
        shuffle(c);
        return join(c);
    }
}


function reversed(a) {
    if (Array.isArray(a)) {
        const c = clone(a);
        reverse(c);
        return c;
    } else {
        // String case
        const c = split(a);
        reverse(c);
        return join(c);
    }
}


function parse(source) {
    return $parse(source, 0).result;
}


function unparse(x) {
    return $unparse(x, new Map());
}


function $unparse(x, alreadySeen) {
    if (Array.isArray(x)) {
        if (x._name !== undefined) {
            // Internal object
            return x._name;
        } else if (alreadySeen.has(x)) {
            return '[…]';
        }
        alreadySeen.set(x, true);
        if (x.length === 0) { return "[]"; }
 
        let s = '[';
        for (let i = 0; i < x.length; ++i) {
            s += $unparse(x[i], alreadySeen) + ', ';
        }
        return s.substring(0, s.length - 2) + ']';
    }

    
    switch (typeof x) {
    case 'object':
        if (x === null) {
            return '∅';
        } else if (x._name !== undefined) {
            // Internal object
            return x._name;
        } else if (alreadySeen.has(x)) {
            return '{…}';
        } else {
            alreadySeen.set(x, true);
            
            let s = '{';
            const keys = $Object.keys(x);
            for (let i = 0; i < keys.length; ++i) {
                const k = keys[i];
                // Hide quadplay-internal members
                if (k[0] !== '_' && k[0] !== '$') {
                    // Quote illegal identifiers used as keys
                    const legalIdentifier = /^[Δ]?(?:[A-Za-z][A-Za-z_0-9]*|[αβγδζηθιλμρσϕφχψτωΩ][_0-9]*)$/.test(k);
                    const key = legalIdentifier ? k : ('"' + k + '"');
                    s += key + ':' + $unparse(x[k], alreadySeen) + ', ';
                }
            }

            // Remove the final ', '
            return s.substring(0, s.length - 2) + '}';
        }

    case 'boolean':
        return x ? 'true' : 'false';
        
    case 'number':
        if (x === Infinity) {
            return '∞';
        } else if (x === -Infinity) {
            return '-∞';
        } else if (x === $Math.PI) {
            return 'π';
        } else if (x === $Math.PI / 2) {
            return '½π';
        } else if (x === $Math.PI / 4) {
            return '¼π';
        } else if (x === $Math.PI * 3 / 4) {
            return '¾π';
        } else if (x === -$Math.PI) {
            return '-π';
        } else if (x === -$Math.PI / 2) {
            return '-½π';
        } else if (x === -$Math.PI / 4) {
            return '-¼π';
        } else if (x === -$Math.PI * 3 / 4) {
            return '-¾π';
        } else if (x === NaN) {
            return 'nan';
        } else {
            return '' + x;
        }

    case 'undefined':
        return '∅';
        
    case 'string':
        return '"' + x + '"';

    case 'function':
        if (x.name) {
            return 'function ' + x.name;
        } else {
            return 'function';
        }

    default:
        return '{builtin}';
    }
}


function magnitude(a) {
    if (typeof a === 'number') {
        return $Math.hypot.apply(null, arguments);
    } else {
        return $Math.sqrt(dot(a, a));
    }
}


function magnitude_squared(a) {
    if (typeof a === 'number') {
        let s = a * a;
        for (let i = 1; i < arguments.length; ++i) {
            s += arguments[i] * arguments[i];
        }
        return s;
    } else {
        return dot(a, a);
    }
}


function direction(a) {
    const m = magnitude(a);
    return (m > 1e-10) ? _mul(a, 1.0 / m) : clone(a);
}

// Used by min and max (and mid). Assumes 'this' is bound to the corresponding $Math function.
function _minOrMax(a, b) {
    const ta = typeof a, tb = typeof b;
    let allNumbers = (ta === 'number') && (tb === 'number');
    const fcn = this;

    if (allNumbers || (arguments.length > 2)) {
        // common case on only numbers
        return fcn.apply($Math, arguments);
    } else {
        if (ta === 'Number') {
            // Swap, b is the vector
            let tmp = b; b = a; a = b;
            tmp = tb; tb = ta; ta = tmp;
        }

        let c = a.constructor ? a.constructor() : $Object.create(null);
        if (tb === 'Number') for (let key in a) c[key] = fcn(a[key], b);
        else                 for (let key in a) c[key] = fcn(a[key], b[key]);
        return $Object.isFrozen(a) ? $Object.freeze(c) : c;
    }
}

// Handles any number of arguments for Numbers, two
// arguments for vectors
function max(a, b) {
    return _minOrMax.apply($Math.max, arguments);
}
    
function min(a, b) {
    return _minOrMax.apply($Math.min, arguments);
}

function mid(a, b, c) {
    return _minOrMax.apply($Math.mid, arguments);
}

function max_component(a) {
    if (typeof a === 'number') { return a; }
    let s = -Infinity;
    for (let key in a) s = $Math.max(s, a[key]);
    return s;
}

function min_component(a) {
    if (typeof a === 'number') { return a; }
    let s = Infinity;
    for (let key in a) s = $Math.min(s, a[key]);
    return s;
}

function MAX(a, b) {
    return (a > b) ? a : b;
}

function MIN(a, b) {
    return (a < b) ? a : b;
}

function ADD(a, b) {
    return a + b;
}

function SUB(a, b) {
    return a - b;
}

function MUL(a, b) {
    return a * b;
}

function SIGN(a) {
    return $Math.sign(a);
}

function MAD(a, b, c) {
    return a * b + c;
}

function DIV(a, b) {
    return a / b;
}

var ABS = $Math.abs;

function CLAMP(a, lo, hi) {
    return $clamp(a, lo, hi);
}

function LERP(a, b, t) {
    return _lerp(a, b, t);
}

function XYZ_ADD_XYZ(v1, v2, r) {
    r.x = v1.x + v2.x;
    r.y = v1.y + v2.y;
    r.z = v1.z + v2.z;
}

function XYZ_SUB_XYZ(v1, v2, r) {
    r.x = v1.x - v2.x;
    r.y = v1.y - v2.y;
    r.z = v1.z - v2.z;
}

function XYZ_MUL_XYZ(v1, v2, r) {
    r.x = v1.x * v2.x;
    r.y = v1.y * v2.y;
    r.z = v1.z * v2.z;
}

function XYZ_MUL(v1, s, r) {
    r.x = v1.x * s;
    r.y = v1.y * s;
    r.z = v1.z * s;
}

function XYZ_DIV(v1, s, r) {
    s = 1 / s;
    r.x = v1.x * s;
    r.y = v1.y * s;
    r.z = v1.z * s;
}

function XYZ_DIV_XYZ(v1, v2, r) {
    r.x = v1.x / v2.x;
    r.y = v1.y / v2.y;
    r.z = v1.z / v2.z;
}

function XYZ_CRS_XYZ(v1, v2, r) {
    const x = v1.y * v2.z - v1.z * v2.y;
    const y = v1.z * v2.x - v1.x * v2.z;
    const z = v1.x * v2.y - v1.y * v2.x;
    r.x = x; r.y = y; r.z = z;
}

function XYZ_DOT_XYZ(v1, v2) {
    return v1.x * v2.x + v1.y * v2.y;
}

function XY_MUL(v1, s, r) {
    r.x = v1.x * s;
    r.y = v1.y * s;
}

function XY_DIV(v1, s, r) {
    s = 1 / s;
    r.x = v1.x * s;
    r.y = v1.y * s;
}

function XY_ADD_XY(v1, v2, r) {
    r.x = v1.x + v2.x;
    r.y = v1.y + v2.y;
}

function XY_SUB_XY(v1, v2, r) {
    r.x = v1.x - v2.x;
    r.y = v1.y - v2.y;
}

function XY_MUL_XY(v1, v2, r) {
    r.x = v1.x * v2.x;
    r.y = v1.y * v2.y;
}

function XY_DIV_XY(v1, v2, r) {
    r.x = v1.x / v2.x;
    r.y = v1.y / v2.y;
}

function XY_DOT_XY(v1, v2) {
    return v1.x * v2.x + v1.y * v2.y;
}

function XY_CRS_XY(v1, v2) {
    return v1.x * v2.y - v1.y * v2.x;
}

function XZ_MUL(v1, s, r) {
    r.x = v1.x * s;
    r.z = v1.z * s;
}

function XZ_DIV(v1, s, r) {
    s = 1 / s;
    r.x = v1.x * s;
    r.z = v1.z * s;
}

function XZ_ADD_XZ(v1, v2, r) {
    r.x = v1.x + v2.x;
    r.z = v1.z + v2.z;
}

function XZ_SUB_XZ(v1, v2, r) {
    r.x = v1.x - v2.x;
    r.z = v1.z - v2.z;
}

function XZ_MUL_XZ(v1, v2, r) {
    r.x = v1.x * v2.x;
    r.z = v1.z * v2.z;
}

function XZ_DIV_XZ(v1, v2, r) {
    r.x = v1.x / v2.x;
    r.z = v1.z / v2.z;
}

function XZ_DOT_XZ(v1, v2) {
    return v1.x * v2.x + v1.z * v2.z;
}

function RGBA_LERP(c1, c2, A, dst) {
    const r = (c2.r - c1.r) * A + c1.r;
    const g = (c2.g - c1.g) * A + c1.g;
    const b = (c2.b - c1.b) * A + c1.b;
    const a = (c2.a - c1.a) * A + c1.a;
    dst.r = r;
    dst.g = g;
    dst.b = b;
    dst.a = a;    
}

function RGBA_ADD_RGBA(c1, c2, r) {
    r.r = c1.r + c2.r;
    r.g = c1.g + c2.g;
    r.b = c1.b + c2.b;
    r.a = c1.a + c2.a;
}

function RGBA_SUB_RGBA(c1, c2, r) {
    r.r = c1.r - c2.r;
    r.g = c1.g - c2.g;
    r.b = c1.b - c2.b;
    r.a = c1.a - c2.a;
}

function RGBA_MUL_RGBA(c1, c2, r) {
    r.r = c1.r * c2.r;
    r.g = c1.g * c2.g;
    r.b = c1.b * c2.b;
    r.a = c1.a * c2.a;
}

function RGBA_DIV_RGBA(c1, c2, r) {
    r.r = c1.r / c2.r;
    r.g = c1.g / c2.g;
    r.b = c1.b / c2.b;
    r.a = c1.a / c2.a;
}

function RGBA_MUL(c, s, r) {
    r.r = c.r * s;
    r.g = c.g * s;
    r.b = c.b * s;
    r.a = c.a * s;
}

function RGBA_DIV(c, s, r) {
    s = 1 / s;
    r.r = c.r * s;
    r.g = c.g * s;
    r.b = c.b * s;
    r.a = c.a * s;
}

function RGBA_DOT_RGBA(c1, c2) {
    return c1.r * c2.r + c1.g * c2.g + c1.b * c2.b + c1.a * c2.a;
}

function RGB_ADD_RGB(c1, c2, r) {
    r.r = c1.r + c2.r;
    r.g = c1.g + c2.g;
    r.b = c1.b + c2.b;
}

function RGB_SUB_RGB(c1, c2, r) {
    r.r = c1.r - c2.r;
    r.g = c1.g - c2.g;
    r.b = c1.b - c2.b;
}

function RGB_MUL_RGB(c1, c2, r) {
    r.r = c1.r * c2.r;
    r.g = c1.g * c2.g;
    r.b = c1.b * c2.b;
}

function RGB_LERP(c1, c2, A, dst) {
    const r = (c2.r - c1.r) * A + c1.r;
    const g = (c2.g - c1.g) * A + c1.g;
    const b = (c2.b - c1.b) * A + c1.b;
    dst.r = r;
    dst.g = g;
    dst.b = b;
}

function RGB_DIV_RGB(c1, c2, r) {
    r.r = c1.r / c2.r;
    r.g = c1.g / c2.g;
    r.b = c1.b / c2.b;
}

function RGB_MUL(c, s, r) {
    r.r = c.r * s;
    r.g = c.g * s;
    r.b = c.b * s;
}

function RGB_DIV(c, s, r) {
    s = 1 / s;
    r.r = c.r * s;
    r.g = c.g * s;
    r.b = c.b * s;
}

function RGB_DOT_RGB(c1, c2) {
    return c1.r * c2.r + c1.g * c2.g + c1.b * c2.b;
}


function MAT3x4_MATMUL_XYZW(A, v, c) {
    const x = v.x, y = v.y, z = v.z, w = v.w;
    c.x = A[0][0] * x + A[0][1] * y + A[0][2] * z + A[0][3] * w;
    c.y = A[1][0] * x + A[1][1] * y + A[1][2] * z + A[1][3] * w;
    c.z = A[2][0] * x + A[2][1] * y + A[2][2] * z + A[2][3] * w;
    c.w = w;
}


function MAT3x4_MATMUL_XYZ(A, v, c) {
    const x = v.x, y = v.y, z = v.z;
    c.x = A[0][0] * x + A[0][1] * y + A[0][2] * z + A[0][3];
    c.y = A[1][0] * x + A[1][1] * y + A[1][2] * z + A[1][3];
    c.z = A[2][0] * x + A[2][1] * y + A[2][2] * z + A[2][3];
}


function MAT3x3_MATMUL_XYZ(A, v, c) {
    const x = v.x, y = v.y, z = v.z;
    c.x = A[0][0] * x + A[0][1] * y + A[0][2] * z;
    c.y = A[1][0] * x + A[1][1] * y + A[1][2] * z;
    c.z = A[2][0] * x + A[2][1] * y + A[2][2] * z;
}

function MAT2x2_MATMUL_XY(A, v, c) {
    const x = v.x, y = v.y;
    c.x = A[0][0] * x + A[0][1] * y;
    c.y = A[1][0] * x + A[1][1] * y;
}

function MAT2x2_MATMUL_XZ(A, v, c) {
    const x = v.x, z = v.z;
    c.x = A[0][0] * x + A[0][1] * z;
    c.z = A[1][0] * x + A[1][1] * z;
}


function lerp_angle(a, b, t) {
    a = _loop(a, -$Math.PI, $Math.PI);
    b = _loop(b, -$Math.PI, $Math.PI);

    // Find the shortest direction
    if (b > a + $Math.PI) {
        b -= 2 * $Math.PI;
    } else if (b < a - $Math.PI) {
        b += 2 * $Math.PI;
    }

    return a + (b - a) * t;    
}



// https://en.wikipedia.org/wiki/SRGB#The_reverse_transformation
function _SRGB_to_RGB_one_channel(u) {
    return u > 0.04045 ? $Math.pow(((u + 0.055) * (1 / 1.055)), 2.4) : u * (1 / 12.92);
}


// https://en.wikipedia.org/wiki/SRGB
function _RGB_to_SRGB_one_channel(u) {
    return  u > 0.0031308 ? 1.055 * $Math.pow(u, (1 / 2.4)) - 0.055 : 12.92 * u;
}

// Convert SRGB[A] to RGB[A]
function _SRGB_to_RGB(color) {
    const result = {
        r: _SRGB_to_RGB_one_channel(color.r),
        g: _SRGB_to_RGB_one_channel(color.g),
        b: _SRGB_to_RGB_one_channel(color.b)
    };
                    
    if (color.a !== undefined) {
        result.a = color.a;
    }

    return result;    
}

// Convert RGB[A] to SRGB[A]
function _RGB_to_SRGB(color) {
    const result = {
        r: _RGB_to_SRGB_one_channel(color.r),
        g: _RGB_to_SRGB_one_channel(color.g),
        b: _RGB_to_SRGB_one_channel(color.b)
    };
                    
    if (color.a !== undefined) {
        result.a = color.a;
    }

    return result;    
}

// Color space conversion for RGB[A] to XYZ[A]. Note: *not* SRGB input!
// May go out of gamut. http://www.brucelindbloom.com/index.html?Eqn_RGB_to_XYZ.html
function _RGB_to_XYZ(color) {
    // Observer = 2°, Illuminant = D65
    const result = {
        x: color.r * 0.4124 + color.g * 0.3576 + color.b * 0.1805,
        y: color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722,
        z: color.r * 0.0193 + color.g * 0.1192 + color.b * 0.9505
    };

    if (color.a !== undefined) {
        result.a = color.a;
    }

    return result;
}

// Color space conversion for XYZ[A] to RGB[A]. Note: *not* SRGB output!
// May go out of gamut.
function _XYZ_to_RGB(color) {
    // Observer = 2°, Illuminant = D65
    const result = {
        r: color.x * 3.2406 + color.y * -1.5372 + color.z * -0.4986,
        g: color.x * -0.9689 + color.y * 1.8758 + color.z * 0.0415,
        b: color.x * 0.0557 + color.y * -0.204 + color.z * 1.057
    };

    if (color.a !== undefined) {
        result.a = color.a;
    }

    return result;
}

function _XYZ_to_LAsBs_one_channel(u) {
    return u > 0.008856 ? $Math.cbrt(u) : 7.787 * u + 16 / 116;
}

// XYZ[A] color to L A* B*[A] (where .as is the color channel and .a
// is the alpha channel) May go out of gamut. l is on the range [0, 100],
// as and bs are on the range [-100, 100]
function _XYZ_to_LAsBs(color) {
    const x = _XYZ_to_LAsBs_one_channel(color.x * (1 / 0.95047));
    const y = _XYZ_to_LAsBs_one_channel(color.y);
    const z = _XYZ_to_LAsBs_one_channel(color.z * (1 / 1.08883));

    // if (116 * y - 16 < 0) throw new Error('Invalid input for XYZ');
    const result = {
        l: $Math.max(0, 116 * y - 16),
        as: 500 * (x - y),
        bs: 200 * (y - z)
    };
    
    if (color.a !== undefined) {
        result.a = color.a;
    }

    return result;
}

function _LAsBs_to_XYZ_one_channel(n) {
    return n > 0.206893034 ? (n * n * n) : (n - 16 / 116) * (1 / 7.787);
}

// L A* B*[A] to XYZ[A] color (where .as is the color channel and .a
// is the alpha channel) May go out of gamut.
function _LAsBs_to_XYZ(color) {
    const y = (color.l + 16) / 116;
    const x = color.as / 500 + y;
    const z = y - color.bs / 200;

    const result = {
        x: 0.95047 * _LAsBs_to_XYZ_one_channel(x),
        y: _LAsBs_to_XYZ_one_channel(y),
        z: 1.08883 * _LAsBs_to_XYZ_one_channel(z)
    };
    
    if (color.a !== undefined) {
        result.a = color.a;
    }

    return result;
}

function perceptual_lerp_color(a, b, t) {
    let was_rgb = false;
    if (a.h === undefined && a.r !== undefined) {
        if (b.h !== undefined || b.r === undefined) { $error("perceptual_lerp_color() requires both colors to be rgb() or hsv()"); }
        // rgb case
        was_rgb = true;
        
    } else if (a.r === undefined && a.h !== undefined) {
        // hsv case
        if (b.r !== undefined || b.h === undefined) { $error("perceptual_lerp_color() requires both colors to be rgb() or hsv()"); }
        if (a.a !== undefined) {
            a = rgba(a);
            b = rgba(b);
        } else {
            a = rgb(a);
            b = rgb(b);
        }
    } else {
        $error("perceptual_lerp_color() requires both colors to be rgb() or hsv()");
    }

    a = _XYZ_to_LAsBs(_RGB_to_XYZ(_SRGB_to_RGB(a)));
    b = _XYZ_to_LAsBs(_RGB_to_XYZ(_SRGB_to_RGB(b)));
    let c = lerp(a, b, t);
    c = _RGB_to_SRGB(_XYZ_to_RGB(_LAsBs_to_XYZ(c)));

    c.r = $clamp(c.r, 0, 1);
    c.g = $clamp(c.g, 0, 1);
    c.b = $clamp(c.b, 0, 1);
    
    if (! was_rgb) {
        // Go back to HSV
        if (c.a !== undefined) {
            c = hsva(c);
        } else {
            c = hsv(c);
        }
    }
    
    return c;
}


function lerp(a, b, t, t_min, t_max) {
    if (t_max !== undefined) {
        // Five-argument version
        return lerp(a, b, (t - t_min) / (t_max - t_min));
    }
    
    // Test if these are numbers quickly using the presence of the toFixed method
    if (! t.toFixed) { throw new Error("The third argument to lerp must be a number"); }
    if (a.toFixed && b.toFixed) {
        return a + (b - a) * t;
    } else {
        const ta = typeof a, tb = typeof b;    
        if (! Array.isArray(a) && (tb === 'object') && (ta === 'object')) {
            // Handle some common cases efficiently without overloading and allocation.
            // The type checking is expensive but is much faster than not doing it.
            const ca = $Object.keys(a).length;
            const cb = $Object.keys(b).length;
            if (ca !== cb) { throw new Error("The arguments to lerp must have the same number of elements"); }

            // xy()
            if (ca === 2 &&
                a.x !== undefined && a.y !== undefined &&
                b.x !== undefined && b.y !== undefined) {
                return {
                    x: a.x + (b.x - a.x) * t,
                    y: a.y + (b.y - a.y) * t
                };
            }

            // rgb()
            if (ca === 3 &&
                a.r !== undefined && a.g !== undefined && a.b !== undefined &&
                b.r !== undefined && b.g !== undefined && b.b !== undefined) {
                return {
                    r: a.r + (b.r - a.r) * t,
                    g: a.g + (b.g - a.g) * t,
                    b: a.b + (b.b - a.b) * t
                };
            }

            // rgba()
            if (ca === 4 &&
                a.r !== undefined && a.g !== undefined && a.b !== undefined && a.a !== undefined &&
                b.r !== undefined && b.g !== undefined && b.b !== undefined && b.a !== undefined) {
                return {
                    r: a.r + (b.r - a.r) * t,
                    g: a.g + (b.g - a.g) * t,
                    b: a.b + (b.b - a.b) * t,
                    a: a.a + (b.a - a.a) * t
                };
            }
        }

        return _add(_mul(a, 1 - t), _mul(b, t));
    }
}


function smoothstep(start, end, t) {
    t = $Math.max(0, $Math.min(1, (t - start) / (end - start)));
    return t * t * (3 - 2 * t);
}


function smootherstep(start, end, t) {
    t = $Math.max(0, $Math.min(1, (t - start) / (end - start)));
    return t * t * t * (t * (t * 6 - 15) + 10);
}


function pow(a, b) {
    const ta = typeof a, tb = typeof b;
    if (ta === 'object') {
        let c = a.constructor ? a.constructor() : $Object.create(null);
        if (tb === 'number') {
            for (let key in a) c[key] = $Math.pow(a[key], b);
        } else {
            for (let key in a) c[key] = $Math.pow(a[key], b[key]);
        }
        return $Object.isFrozen(a) ? $Object.freeze(c) : c;
    } else if ((ta === 'number') && (tb === 'object')) {
        let c = b.constructor ? b.constructor() : Object.create(null);
        for (let key in b) c[key] = $Math.pow(a, b[key]);
        return $Object.isFrozen(a) ? $Object.freeze(c) : c;
    } else {
        return $Math.ceil(a, b);
    }
}

////////////////////////////////////////////////////////////////////////////////////////
//
// Path-finding
//
//

function find_map_path(map, start, goal, edgeCost, costLayer) {
    if (is_array(edgeCost)) {
        // Create an edgeTable
        const edgeTable = new Map();
        for (let i = 0; i < edgeCost.length; i += 2) {
            edgeTable.set(edgeCost[i], edgeCost[i + 1]);
        }
        
        edgeCost = function (A, B, m) {
            if (B === undefined) { return infinity; }
            const c = edgeTable.get(B);
            return (c === undefined) ? 1 : c;
        };
    }

    function estimatePathCost(A, B, m) {
        let dx = $Math.abs(A.x - B.x);
        let dy = $Math.abs(A.y - B.y);
        if (map.wrap_x) { dx = $Math.min(dx, map.size.x - 1 - dx); }
        if (map.wrap_y) { dy = $Math.min(dy, map.size.y - 1 - dy); }
        return dx + dy;
    }

    function getNeighbors(node, m) {
        const neighbors = [];
        if (node.x > 0) {
            neighbors.push({x:node.x - 1, y:node.y});
        } else if (map.wrap_x) {
            neighbors.push({x:map.size.x - 1, y:node.y});
        }

        if (node.x < map.size.x - 1) {
            neighbors.push({x:node.x + 1, y:node.y});
        } else if (map.wrap_x) {
            neighbors.push({x:0, y:node.y});
        }

        if (node.y > 0) {
            neighbors.push({x:node.x, y:node.y - 1});
        } else if (map.wrap_y) {
            neighbors.push({x:node.x, y:map.size.y - 1});
        }

        if (node.y < map.size.y + 1 - 1) {
            neighbors.push({x:node.x, y:node.y + 1});
        } else if (map.wrap_y) {
            neighbors.push({x:node.x, y:0});
        }
        
        return neighbors;
    }

    return find_path(floor(start), floor(goal), estimatePathCost, edgeCost, getNeighbors, function (N) { return N.x + N.y * map.size.x * 2; }, map);
}


/** Used by find_path */
function $Step(last, startCost, goalCost) {
    this.last          = last;
    this.previous      = null;
    this.costFromStart = startCost;
    this.costToGoal    = goalCost;
    this.inQueue       = true;
}

/** Used by find_path */
$Step.prototype.cost = function() {
    return this.costFromStart + this.costToGoal;
}

// A PriorityQueue is a queue that can arranges elements by cost
// instead of arrival order

function _PriorityQueue() {
    this.elementArray = [];
    this.costArray    = [];
}


/** Number of elements in the queue */
_PriorityQueue.prototype.length = function() {
    return this.elementArray.length;
}


/** Assumes that element is not already in the queue */
_PriorityQueue.prototype.insert = function(element, cost) {
    this.elementArray.push(element);
    this.costArray.push(cost);
}


/** Erases the queue */
_PriorityQueue.prototype.clear = function() {
    this.elementArray = [];
    this.costArray    = [];
}


/** Updates the cost of element in the queue */
_PriorityQueue.prototype.update = function(element, newCost) {
    const i = this.elementArray.indexOf(element);

    if (i === -1) {
        throw new Error("" + element + " is not in the PriorityQueue");
    }

    this.costArray[i] = newCost;
}


/** Removes the minimum cost element and returns it */
_PriorityQueue.prototype.removeMin = function() {
    if (this.elementArray.length === 0) {
        throw new Error("PriorityQueue is empty");
    }
    
    let j = 0;
    for (let i = 1, m = this.costArray[j]; i < this.elementArray.length; ++i) {
        if (this.costArray[i] < m) {
            m = this.costArray[i];
            j = i;
        }
    }

    const v = this.elementArray[j];
    this.costArray.splice(j, 1);
    this.elementArray.splice(j, 1);
    return v;
}


function split(str, c) {
    if (c === '') {
        return Array.from(str);
    } else {
        return str.split(c);
    }
}


function load_local(key, default_value) {
    let table = $window.localStorage.getItem('GAME_STATE_' + $gameURL);
    if (! table) { return default_value; }
    
    table = JSON.parse(table);
    const value = table[key];
    if (value) {
        return parse(value);
    } else {
        return default_value;
    }
}


function save_local(key, value) {
    let table = $window.localStorage.getItem('GAME_STATE_' + $gameURL);
    if (table) {
        table = JSON.parse(table);
    } else {
        table = {};
    }

    if (value === undefined) {
        delete table[key];
    } else {
        const v = unparse(value);
        if (v.length > 2048) {
            throw new Error('Cannot store_local() a value that is greater than 2048 characters after unparse()');
        }
        table[key] = v;
        if ($Object.keys(table).length > 128) {
            throw new Error('Cannot store_local() more than 128 separate keys.');
        }
    }

    $window.localStorage.setItem('GAME_STATE_' + $gameURL, JSON.stringify(table));
}


function play_sound(sound, loop, volume, pan, pitch, time) {
    if (sound.sound && (arguments.length === 1)) {
        // Object version
        loop    = sound.loop;
        volume  = sound.volume;
        pan     = sound.pan;
        pitch   = sound.pitch;
        time    = sound.time;
        sound   = sound.sound;
    }

    if (pan && pan.x !== undefined && pan.y !== undefined) {
        // Positional sound
        pan = transform_cs_to_ss(transform_ws_to_cs(pan))
        pan = $clamp((2 * pan.x / SCREEN_SIZE.x) - 1, -1, 1)
    }

    return $play_sound(sound, loop, volume, pan, pitch, time);    
}


/**
   Finds a good path from start to goal using the A* algorithm, and
   returns it as a list of nodes to visit.  Returns null if there is
   no path.

   map: Map

   start: Node

   goal: Node

   costEstimator: function(Map, Node, Node) that guesses what the cost
   is to go between the nodes.

   edgeCost: function(Map, Node, Node) that returns the exact cost to
   move between nodes that are known to be neighbors.

   getNeighbors: function(Map, Node) that returns an array of all
   neighbors.  

   getNodeID: function(Map, Node) that returns a unique integer or
   string for the node.  IDs must be unique and deterministic--
   getNodeID(a) === getNodeID(b) must be true if and only if a and b describe
   the same location.

   This function is designed to work with any kind of Map and Node--they 
   aren't specific classes and need not have any particular methods.

   It takes functions costEstimator, edgeCost, and getNeighbors (i.e.,
   instead of requiring methods on Map/Node) so that the map
   implementation is unconstrained, and so that the same map and nodes
   can be used with different cost estimates.  For example, a bird, a
   fish, and a cat have different movement modes and thus would have
   different costs for moving across different types of terrain in the
   same map.
*/
function find_path(start, goal, costEstimator, edgeCost, getNeighbors, nodeToID, map) {
    if (start === undefined) { $error('The start_node argument to find_path() must not be nil'); }
    if (goal === undefined) { $error('The goal_node argument to find_path() must not be nil'); }
    if (typeof costEstimator !== 'function') { $error('The estimate_path_cost() argument to find_path() must be a function'); }
    if (typeof getNeighbors !== 'function') { $error('The get_neighbors() argument to find_path() must be a function'); }
    if (typeof edgeCost !== 'function') { $error('The edge_cost() argument to find_path() must be a function'); }
    if (typeof nodeToID !== 'function') { $error('The node_to_ID() argument to find_path() must be a function'); }
    
    // Paths encoded by their last Step paired with expected shortest
    // distance
    const queue = new $PriorityQueue();
    
    // Maps each Node to the Step on the best known path to that Node.
    const bestPathTo = new Map();

    let shortest = new $Step(start, 0, costEstimator(start, goal, map));
    bestPathTo.set(nodeToID(start, map), shortest);
    queue.insert(shortest, shortest.cost());

    const goalID = nodeToID(goal, map);

    while (queue.length() > 0) {
        shortest = queue.removeMin();
        shortest.inQueue = false;

        // Last node on the shortest path
        const P = shortest.last;
        
        if (nodeToID(P, map) === goalID) {
            // We're done.  Generate the path to the goal by retracing steps
            const path = [goal];

            // Construct the path backwards
            while (shortest.previous) {
                shortest = bestPathTo.get(nodeToID(shortest.previous, map));
                path.push(shortest.last);
            }
            return path.reverse();
        }

        // Consider all neighbors of P (that are still in the queue
        // for consideration)
        const neighbors = getNeighbors(P, map);
        if (! Array.isArray(neighbors)) { $error('The get_neighbors() function passed to find_path() must return an array of nodes. Received: ' + unparse(neighbors)); }
        for (let i = 0; i < neighbors.length; ++i) {
            const N = neighbors[i];
            if (N === undefined) { $error('get_neighbors() returned an array containing nil node in find_path().'); }
            const id = nodeToID(N, map);
            const cost = edgeCost(P, N, map);
            if (typeof cost !== 'number') { $error('edge_cost() must return a number. Received: ' + unparse(cost)); }
            
            if (cost < Infinity) {
                const newCostFromStart = shortest.costFromStart + cost;
            
                // Find the current-best known way to N (or create it, if there isn't one)
                let oldBestToN = bestPathTo.get(id);
                if (oldBestToN === undefined) {
                    // Create an expensive dummy path that will immediately be overwritten
                    oldBestToN = new $Step(N, Infinity, costEstimator(N, goal, map));
                    bestPathTo.set(id, oldBestToN);
                    queue.insert(oldBestToN, oldBestToN.cost());
                }
                
                // Have we discovered a new best way to N?
                if (oldBestToN.inQueue && (oldBestToN.costFromStart > newCostFromStart)) {
                    // Update the step at this node
                    oldBestToN.costFromStart = newCostFromStart;
                    oldBestToN.previous = P;
                    queue.update(oldBestToN, oldBestToN.cost());
                }
            }
            
        } // for each neighbor
        
    } // while queue not empty

    // There was no path from start to goal
    return undefined;
}



///////////////////////////////////////////////////////////////////////////////

// Filter functions



///////////////////////////////////////////////////////////////////////////////


var $GeneratorFunction = $Object.getPrototypeOf(function*(){}).constructor;

/** Creates a new coroutine from code in this environment.  Invoke next() repeatedly on the
    returned object to execute it. */
function _makeCoroutine(code) {
    return (new $GeneratorFunction(code))();
}


////////////////////////////////////////////////////////////////////////////////////////
//                 Software rendering implementation of the Host API                  //
////////////////////////////////////////////////////////////////////////////////////////

/** Used by show() */
function $zSort(a, b) { return a.z - b.z; }

function get_mode() {
    return $gameMode;
}

function get_previous_mode() {
    return $prevMode;
}


var $lastBecause = ''
function because(reason) {
    $lastBecause = reason;
}

function push_mode(mode, ...args) {
    $verifyLegalMode(mode);

    // Push the stacks
    $previousModeGraphicsCommandListStack.push($previousModeGraphicsCommandList);
    $mode_framesStack.push(mode_frames);
    $modeStack.push($gameMode);
    $prevModeStack.push($prevMode);

    mode_frames = 0;
    $prevMode = $gameMode;
    $gameMode = mode;
    
    $previousModeGraphicsCommandList = $previousGraphicsCommandList;

    // Reset the graphics
    $graphicsCommandList = [];
    $previousGraphicsCommandList = [];

    $systemPrint('Pushing into mode ' + mode._name + ($lastBecause ? ' because "' + $lastBecause + '"' : ''));

    // Run the enter callback on the new mode
    $iteratorCount = new WeakMap();
    $gameMode.$enter.apply(null, args);

    throw {nextMode: mode};

}


function quit_game() {
    $systemPrint('Quitting the game' + ($lastBecause ? ' because "' + $lastBecause + '"' : ''));
    throw {quit_game:1};
}


function launch_game(url) {
    $systemPrint('Launching ' + url + ($lastBecause ? ' because "' + $lastBecause + '"' : ''));
    throw {launch_game:url};
}


function reset_game() {
    $systemPrint('Resetting the game' + ($lastBecause ? ' because "' + $lastBecause + '"' : ''));
    throw {reset_game:1};
}


function pop_mode(...args) {
    if ($modeStack.length === 0) { throw new Error('Cannot pop_mode() from a mode entered by set_mode()'); }

    // Run the leave callback on the current mode
    var old = $gameMode;
    $prevMode = $prevModeStack.pop();

    // Pop the stacks
    $previousGraphicsCommandList = $previousModeGraphicsCommandList;
    $previousModeGraphicsCommandList = $previousModeGraphicsCommandListStack.pop();
    $gameMode = $modeStack.pop();
    mode_frames = $mode_framesStack.pop();

    $iteratorCount = new WeakMap();
    old.$leave();

    // Reset the graphics
    $graphicsCommandList = [];
    
    $systemPrint('Popping back to mode ' + $gameMode._name + ($lastBecause ? ' because "' + $lastBecause + '"' : ''));

    // Run the pop_mode event on $gameMode if it exists
    var eventName = '$pop_modeFrom' + old._name;
    if ($gameMode[eventName] !== undefined) {
        // repeat here so that the "this" is set correctly to $gameMode
        $iteratorCount = new WeakMap();
        $gameMode[eventName](...args);
    }

    throw {nextMode: $gameMode};
}


function set_mode(mode, ...args) {
    $verifyLegalMode(mode);
    
    // Erase the stacks
    $previousModeGraphicsCommandListStack = [];
    $mode_framesStack = [];
    $modeStack = [];
    $prevModeStack = [];

    // Set up the new mode
    $prevMode = $gameMode;
    $gameMode = mode;

    // Loop nesting is irrelvant, since we're about to leave
    // that scope permanently.
    $iteratorCount = new WeakMap();
    
    // Run the leave callback on the current mode
    if ($prevMode) { $prevMode.$leave(); }
    
    mode_frames = 0;

    // Save the previous graphics list for draw_previous_mode()
    $previousModeGraphicsCommandList = $previousGraphicsCommandList;

    // Reset the graphics
    $graphicsCommandList = [];
    $previousGraphicsCommandList = [];
    
    $systemPrint('Entering mode ' + mode._name + ($lastBecause ? ' because "' + $lastBecause + '"' : ''));
    
    // Run the enter callback on the new mode
    $iteratorCount = new WeakMap();
    if ($gameMode.$enter) { $gameMode.$enter.apply(null, args); }

    throw {nextMode: mode};
}


function $verifyLegalMode(mode) {
    try {
        if (mode.$frame.constructor.constructor.name !== 'GeneratorFunction') {
            throw 1;
        }
    } catch (e) {
        throw new Error('Not a valid mode: ' + unparse(mode));
    }
}


function now() {
    return performance.now() * 0.001;
}


function local_time() {
    const d = new Date();
    
    return {
        year:        d.getFullYear(),
        month:       d.getMonth(),
        day:         d.getDate(),
        hour:        d.getHours(),
        minute:      d.getMinutes(),
        second:      d.getSeconds(),
        millisecond: d.getMilliseconds(),
        weekday:     d.getDay(),
        day_second:  (d.getHours() * 60 + d.getMinutes()) * 60 + d.getSeconds() + d.getMilliseconds() * 0.001,
        timezone:    d.getTimezoneOffset()
    };
}

