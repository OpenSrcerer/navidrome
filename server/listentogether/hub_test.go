package listentogether

import (
	"math"
	"testing"
	"time"
)

func newTestSession(durations ...float32) *LiveSession {
	tracks := make([]TrackInfo, len(durations))
	queue := make([]int, len(durations))
	for i, d := range durations {
		tracks[i] = TrackInfo{ID: "t", Duration: d}
		queue[i] = i
	}
	return &LiveSession{
		tracks:       tracks,
		queue:        queue,
		currentIndex: 0,
		lastUpdate:   time.Now(),
		participants: make(map[string]*Participant),
	}
}

func TestEffectivePositionLocked(t *testing.T) {
	ls := newTestSession(300)

	// Paused: position is just the base, regardless of elapsed time.
	ls.positionBase = 42
	ls.isPlaying = false
	ls.lastUpdate = time.Now().Add(-5 * time.Second)
	if got := ls.effectivePositionLocked(); got != 42 {
		t.Fatalf("paused position = %v, want 42", got)
	}

	// Playing: position advances by wall-clock elapsed since lastUpdate.
	ls.positionBase = 10
	ls.isPlaying = true
	ls.lastUpdate = time.Now().Add(-2 * time.Second)
	if got := ls.effectivePositionLocked(); math.Abs(got-12) > 0.5 {
		t.Fatalf("playing position = %v, want ~12", got)
	}

	// Playing past the end clamps to the track duration.
	ls.positionBase = 299
	ls.lastUpdate = time.Now().Add(-10 * time.Second)
	if got := ls.effectivePositionLocked(); got != 300 {
		t.Fatalf("clamped position = %v, want 300", got)
	}
}

func TestAdvanceToNextLocked(t *testing.T) {
	ls := newTestSession(300, 200)
	ls.isPlaying = true
	ls.positionBase = 295
	ls.lastUpdate = time.Now()

	// Advancing from the first track moves to the next, resets position, keeps playing.
	ls.advanceToNextLocked()
	if ls.currentIndex != 1 {
		t.Fatalf("currentIndex = %d, want 1", ls.currentIndex)
	}
	if ls.positionBase != 0 {
		t.Fatalf("positionBase = %v, want 0", ls.positionBase)
	}
	if !ls.isPlaying {
		t.Fatal("expected isPlaying to remain true after advance")
	}

	// Advancing from the last track stops playback at the end of the track.
	ls.advanceToNextLocked()
	if ls.currentIndex != 1 {
		t.Fatalf("currentIndex = %d, want 1 (no advance past end)", ls.currentIndex)
	}
	if ls.isPlaying {
		t.Fatal("expected isPlaying false at end of queue")
	}
	if ls.positionBase != 200 {
		t.Fatalf("positionBase = %v, want 200 (end of last track)", ls.positionBase)
	}
}

func TestCurrentDurationLocked(t *testing.T) {
	ls := newTestSession(120, 240)
	if got := ls.currentDurationLocked(); got != 120 {
		t.Fatalf("duration[0] = %v, want 120", got)
	}
	ls.currentIndex = 1
	if got := ls.currentDurationLocked(); got != 240 {
		t.Fatalf("duration[1] = %v, want 240", got)
	}
	// Out-of-range / empty queue returns 0.
	ls.currentIndex = 5
	if got := ls.currentDurationLocked(); got != 0 {
		t.Fatalf("duration[oob] = %v, want 0", got)
	}
}

func TestScheduleAdvanceFires(t *testing.T) {
	ls := newTestSession(0.05, 100) // 50ms first track
	ls.isPlaying = true
	ls.positionBase = 0
	ls.lastUpdate = time.Now()

	ls.mu.Lock()
	ls.scheduleAdvanceLocked()
	ls.mu.Unlock()

	// The timer should auto-advance to the next track shortly after the
	// (very short) first track is expected to end.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		ls.mu.RLock()
		idx := ls.currentIndex
		ls.mu.RUnlock()
		if idx == 1 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("auto-advance timer did not fire within 2s")
}
