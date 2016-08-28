import {
  MapFunction,
  SubscribeFunction,
  Consumer
} from "./frp-common";

import {Future, BehaviorFuture} from "./Future";
import * as F from "./Future";
import {Stream} from "./Stream";

/**
 * A behavior is a value that changes over time. Conceptually it can
 * be though of as a function from time to a value. I.e. `type
 * Behavior<A> = (t: Time) => A`.
 */
export abstract class Behavior<A> {
  public cbListeners: ((b: A) => void)[] = [];
  // The consumers that depends on this behavior
  public listeners: Consumer<any>[] = [];
  public last: A;
  public pushing: boolean;

  public publish(b: A): void {
    this.last = b;

    let l = this.cbListeners.length;
    for (let i = 0; i < l; i++) {
      this.cbListeners[i](b);
    }

    l = this.listeners.length;
    for (let i = 0; i < l; i++) {
      this.listeners[i].push(b, this);
    }
  };

  public abstract push(a: any, changed: Behavior<any>): void;

  public abstract pull(): A;

  set def(b: Behavior<A>) {
    b.cbListeners.push(...this.cbListeners);
    b.listeners.push(...this.listeners);
    this.cbListeners = b.cbListeners;
    this.listeners = b.listeners;
  }

  public map<B>(fn: MapFunction<A, B>): Behavior<B> {
    const newB = new MapBehavior<A, B>(this, fn);
    this.listeners.push(newB);
    return newB;
  }

  public of: <A>(v: A) => Behavior<A> = of;
  static of: <A>(v: A) => Behavior<A> = of;

  public chain<B>(fn: (a: A) => Behavior<B>): Behavior<B> {
    const newB = new ChainBehavior<A, B>(this, fn);
    this.listeners.push(newB);
    return newB;
  }

  public addListener(listener: Consumer<any>): void {
    this.listeners.push(listener);
  }

  public unlisten(listener: Consumer<any>): void {
    // The indexOf here is O(n), where n is the number of listeners,
    // if using a linked list it should be possible to perform the
    // unsubscribe operation in constant time.
    const l = this.listeners;
    const idx = l.indexOf(listener);
    if (idx !== -1) {
      // if the subscriber is not at the end of the list we overwrite
      // it with the element at the end of the list
      if (idx !== l.length - 1) {
        l[idx] = l[l.length - 1];
      }
      l.length--; // remove the last element of the list
    }
  }
}

export function of<B>(val: B): Behavior<B> {
  return new ConstantBehavior(val);
}

// Impure function that gets the current value of a behavior.
export function at<B>(b: Behavior<B>): B {
  return b.pushing === true ? b.last : b.pull();
}

class ConstantBehavior<A> extends Behavior<A> {
  constructor(public last: A) {
    super();
    this.pushing = true;
  }

  public push(): void {
    throw new Error("Cannot push a value to a constant behavior");
  }

  public pull(): A {
    return this.last;
  }
}

class MapBehavior<A, B> extends Behavior<B> {
  constructor(
    private parent: Behavior<any>,
    private fn: MapFunction<A, B>
  ) {
    super();
    this.pushing = parent.pushing;
    if (parent.pushing) {
      this.last = fn(at(parent));
    }
  }

  public push(a: any): void {
    this.pushing = true;
    this.last = this.fn(a);
    this.publish(this.last);
  }

  public pull(): B {
    return this.fn(at(this.parent));
  }
}

class ChainBehavior<A, B> extends Behavior<B> {
  // The last behavior returned by the chain function
  private innerB: Behavior<B>;
  constructor(
    private outer: Behavior<any>,
    private fn: (a: A) => Behavior<B>
  ) {
    super();
    this.innerB = this.fn(at(this.outer));
    this.pushing = outer.pushing && this.innerB.pushing;
    this.innerB.listeners.push(this);
    this.last = at(this.innerB);
  }

  public push(a: any, changed: Behavior<any>): void {
    if (changed === this.outer) {
      this.innerB.unlisten(this);
      const newInner = this.fn(at(this.outer));
      newInner.addListener(this);
      this.innerB = newInner;
    }
    this.last = at(this.innerB);
    this.publish(this.last);
  }

  public pull(): B {
    return at(this.fn(at(this.outer)));
  }
}

class FunctionBehavior<A> extends Behavior<A> {
  constructor(private fn: () => A) {
    super();
    this.pushing = false;
  }

  public push(v: A): void {
    throw new Error("Cannot push to a FunctionBehavior");
  }

  public pull(): A {
    return this.fn();
  }
}

/** @private */
class ApBehavior<A, B> extends Behavior<B> {
  public last: B;

  constructor(
    private fn: Behavior<(a: A) => B>,
    private val: Behavior<A>
  ) {
    super();
    this.pushing = fn.pushing && val.pushing;
    this.last = at(fn)(at(val));
  }

  public push(): void {
    const fn = at(this.fn);
    const val = at(this.val);
    this.last = fn(val);
    this.publish(this.last);
  }

  public pull(): B {
    return at(this.fn)(at(this.val));
  }
}

class SinkBehavior<B> extends Behavior<B> {
  constructor(public last: B) {
    super();
    this.pushing = true;
  }

  public push(v: B): void {
    this.last = v;
    this.publish(v);
  }

  public pull(): B {
    return this.last;
  }
}

/**
 * A placeholder behavior is a behavior without any value. It is used
 * to do value recursion in `./framework.ts`.
 * @private
 */
export class PlaceholderBehavior<B> extends Behavior<B> {
  private source: Behavior<B>;
  constructor() {
    super();
    this.pushing = false;
  }

  public push(v: B): void {
    this.last = v;
    this.publish(v);
  }

  public pull(): B {
    return this.last;
  }

  public replaceWith(b: Behavior<B>): void {
    this.source = b;
    b.addListener(this);
    this.pushing = b.pushing;
    if (b.pushing === true) {
      this.push(at(b));
    }
  }
}

export function placeholder(): PlaceholderBehavior<any> {
  return new PlaceholderBehavior();
}

class WhenBehavior extends Behavior<Future<{}>> {
  constructor(private parent: Behavior<boolean>) {
    super();
    this.pushing = true;
    parent.addListener(this);
    this.push(at(parent));
  }
  public push(val: boolean): void {
    if (val === true) {
      this.last = Future.of({});
    } else {
      this.last = new BehaviorFuture(this.parent);
    }
  }
  public pull(): Future<{}> {
    return this.last;
  }
}

/**
 * Take a behavior `b` of booleans and return a behavior that for time
 * `t` contains a future that occurs when `b` is true after `t`.
 * @param b - A boolean valued behavior.
 */
export function when(b: Behavior<boolean>): Behavior<Future<{}>> {
  return new WhenBehavior(b);
}

// FIXME: This can probably be made less ugly.
class SnapshotBehavior<A> extends Behavior<Future<A>> {
  private afterFuture: boolean;
  constructor(private parent: Behavior<A>, future: Future<any>) {
    super();
    if (future.occured === true) {
      // Future has occurred at some point in the past
      this.afterFuture = true;
      this.pushing = parent.pushing;
      parent.addListener(this);
      this.last = Future.of(at(parent));
    } else {
      this.afterFuture = false;
      this.pushing = true;
      this.last = F.sink<A>();
      future.listen(this);
    }
  }
  public push(val: any): void {
    if (this.afterFuture === false) {
      // The push is coming from the Future, it has just occurred.
      this.afterFuture = true;
      this.last.resolve(at(this.parent));
      this.parent.addListener(this);
    } else {
      // We are recieving an update from `parent` after `future` has
      // occurred.
      this.last = Future.of(val);
    }
  }
  public pull(): Future<A> {
    return this.last;
  }
}

export function snapshot<A>(
  behavior: Behavior<A>,
  future: Future<any>
): Behavior<Future<A>> {
  return new SnapshotBehavior(behavior, future);
}

class SwitcherBehavior<A> extends Behavior<A> {
  constructor(private behavior: Behavior<A>, next: Future<Behavior<A>>) {
    super();
    this.last = at(behavior);
    behavior.addListener(this);
    // FIXME: Using `bind` is hardly optimal for performance.
    next.subscribe(this.doSwitch.bind(this));
  }
  public push(val: A): void {
    this.last = val;
    this.publish(val);
  }
  public pull(): A {
    return this.last;
  }
  private doSwitch(newBehavior: Behavior<A>): void {
    this.behavior.unlisten(this);
    newBehavior.addListener(this);
    this.push(at(newBehavior));
  }
}

/**
 * From an initial behavior and a future of a behavior `switcher`
 * creates a new behavior that acts exactly like `initial` until
 * `next` occurs after which it acts like the behavior it contains.
 */
export function switcher<A>(
  init: Behavior<A>,
  next: Future<Behavior<A>>
) {
  return new SwitcherBehavior(init, next);
}

class StepperBehavior<B> extends Behavior<B> {
  constructor(initial: B, private steps: Stream<B>) {
    super();
    this.pushing = true;
    this.last = initial;
    steps.eventListeners.push(this);
  }

  public push(val: B): void {
    this.last = val;
    this.publish(val);
  }

  public pull(): B {
    throw new Error("Cannot pull from StepperBehavior");
  }
}

/**
 * Creates a Behavior whose value is the last occurrence in the stream.
 * @param initial the initial value that the behavior has
 * @param steps the stream that will change the value of the behavior
 */
export function stepper<B>(initial: B, steps: Stream<B>): Behavior<B> {
  return new StepperBehavior(initial, steps);
}

class ScanBehavior<A, B> extends Behavior<B> {
  constructor(initial: B,
              private fn: (a: A, b: B) => B,
              private source: Stream<A>) {
    super();
    this.pushing = true;
    this.last = initial;
    source.eventListeners.push(this);
  }
  public push(val: A): void {
    this.last = this.fn(val, this.last);
    this.publish(this.last);
  }
  public pull(): B {
    throw new Error("Cannot pull from Scan");
  }
}

export function scan<A, B>(fn: (a: A, b: B) => B, init: B, source: Stream<A>): Behavior<Behavior<B>> {
  return fromFunction(() => new ScanBehavior(init, fn, source));
}

// Creates a pull Behavior from an impure function
export function fromFunction<B>(fn: () => B): Behavior<B> {
  return new FunctionBehavior(fn);
}

export function sink<A>(initialValue: A): Behavior<A> {
  return new SinkBehavior<A>(initialValue);
}

export function subscribe<A>(fn: SubscribeFunction<A>, b: Behavior<A>): void {
  b.cbListeners.push(fn);
}

export function publish<A>(a: A, b: Behavior<A>): void {
  b.publish(a);
}

export function map<A, B>(fn: MapFunction<A, B> , b: Behavior<A>): Behavior<B> {
  return b.map(fn);
}

export function ap<A, B>(fnB: Behavior<(a: A) => B>, valB: Behavior<A>): Behavior<B> {
  const newB = new ApBehavior<A, B>(fnB, valB);
  fnB.listeners.push(newB);
  valB.listeners.push(newB);
  return newB;
}

export function isBehavior(b: any): b is Behavior<any> {
  return b instanceof Behavior;
}