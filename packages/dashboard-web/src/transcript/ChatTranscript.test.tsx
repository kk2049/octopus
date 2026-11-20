import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatScroller } from "./ChatTranscript.js";

describe("trusted ChatScroller", () => {
  it("distinguishes append, prepend and unrelated paints without fighting touch scroll", () => {
    let scrollTop = 0;
    let scrollHeight = 1_000;
    const view = render(
      <ChatScroller anchor="ticket-1" followKey="tail-0" prependKey={200} id="scroller">
        <div>first frame</div>
      </ChatScroller>,
    );
    const scroller = view.container.querySelector<HTMLDivElement>("#scroller")!;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => 200 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      // Browsers clamp scrollTop to the scrollable range; jsdom stores an
      // arbitrary number. Model the browser here so "snap to bottom" means
      // the same thing in this unit test and on a phone.
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = Math.max(0, Math.min(value, scrollHeight - 200));
        },
      },
    });

    // A tail frame arriving while pinned follows to the bottom.
    view.rerender(
      <ChatScroller anchor="ticket-1" followKey="tail-1" prependKey={200} id="scroller">
        <div>measured frame</div>
      </ChatScroller>,
    );
    expect(scroller.scrollTop).toBe(800);

    scroller.scrollTop = 700;
    fireEvent.scroll(scroller);

    // An unrelated projection repaint must not write scrollTop and cancel a
    // phone's in-progress momentum gesture.
    view.rerender(
      <ChatScroller anchor="ticket-1" followKey="tail-1" prependKey={200} id="scroller">
        <div>unrelated frame</div>
      </ChatScroller>,
    );
    expect(scroller.scrollTop).toBe(700);

    // A live append is below this reader. Keep the same visible content rather
    // than preserving distance from the bottom and dragging them 300px newer.
    scrollHeight = 1_300;
    view.rerender(
      <ChatScroller anchor="ticket-1" followKey="tail-2" prependKey={200} id="scroller">
        <div>appended frame</div>
      </ChatScroller>,
    );
    expect(scroller.scrollTop).toBe(700);

    // A history page is inserted above the same visible content. Compensate
    // exactly the inserted height, so the old first visible row stays put.
    scrollHeight = 1_600;
    view.rerender(
      <ChatScroller anchor="ticket-1" followKey="tail-2" prependKey={0} id="scroller">
        <div>prepended frame</div>
      </ChatScroller>,
    );
    expect(scroller.scrollTop).toBe(1_000);

    scrollHeight = 900;
    view.rerender(
      <ChatScroller anchor="ticket-2" followKey="tail-a" prependKey={0} id="scroller">
        <div>another ticket</div>
      </ChatScroller>,
    );
    expect(scroller.scrollTop).toBe(700);
  });

  it("lets a touch gesture leave a rapidly growing live tail", () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(callback);
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );

    let scrollTop = 0;
    let scrollHeight = 1_000;
    const view = render(
      <ChatScroller anchor="ticket-live" followKey="tail-0" prependKey={200} id="live-scroller">
        <div>first live frame</div>
      </ChatScroller>,
    );
    const scroller = view.container.querySelector<HTMLDivElement>("#live-scroller")!;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => 200 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = Math.max(0, Math.min(value, scrollHeight - 200));
        },
      },
    });

    view.rerender(
      <ChatScroller anchor="ticket-live" followKey="tail-1" prependKey={200} id="live-scroller">
        <div>measured live frame</div>
      </ChatScroller>,
    );
    expect(scroller.scrollTop).toBe(800);

    fireEvent.touchStart(scroller, { touches: [{ clientY: 300 }] });

    // A new frame and its late layout arrive after touchstart but before the
    // browser's first scroll event. The old 48px test treated this 20px gap as
    // still pinned and immediately jumped back to the tail.
    scrollHeight = 1_020;
    view.rerender(
      <ChatScroller anchor="ticket-live" followKey="tail-2" prependKey={200} id="live-scroller">
        <div>frame racing the gesture</div>
      </ChatScroller>,
    );
    resizeCallbacks[0]?.([], {} as ResizeObserver);
    expect(scroller.scrollTop).toBe(800);

    // Move only 10px away — deliberately inside the former 48px dead zone —
    // and keep streaming. Neither the semantic tail update nor the resize may
    // take scrolling back from the reader.
    fireEvent.touchMove(scroller, { touches: [{ clientY: 310 }] });
    scroller.scrollTop = 790;
    fireEvent.scroll(scroller);
    scrollHeight = 1_050;
    view.rerender(
      <ChatScroller anchor="ticket-live" followKey="tail-3" prependKey={200} id="live-scroller">
        <div>another racing frame</div>
      </ChatScroller>,
    );
    resizeCallbacks[0]?.([], {} as ResizeObserver);
    expect(scroller.scrollTop).toBe(790);

    fireEvent.touchEnd(scroller, { touches: [], changedTouches: [{ clientY: 310 }] });
    scrollHeight = 1_080;
    view.rerender(
      <ChatScroller anchor="ticket-live" followKey="tail-4" prependKey={200} id="live-scroller">
        <div>frame after the gesture</div>
      </ChatScroller>,
    );
    resizeCallbacks[0]?.([], {} as ResizeObserver);
    expect(scroller.scrollTop).toBe(790);

    // Scrolling toward the tail deliberately reattaches inside the 48px
    // threshold, preserving the convenient follow behavior.
    scroller.scrollTop = 860;
    fireEvent.scroll(scroller);
    scrollHeight = 1_100;
    view.rerender(
      <ChatScroller anchor="ticket-live" followKey="tail-5" prependKey={200} id="live-scroller">
        <div>reattached frame</div>
      </ChatScroller>,
    );
    expect(scroller.scrollTop).toBe(900);
  });
});
