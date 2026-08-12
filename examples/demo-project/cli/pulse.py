"""Command-line front end: wire a source to a rollup to the API and print."""


class Runner:
    """Owns one pass over a source, so a caller can inspect what was refused."""

    def __init__(self, name: str, capacity: int = 3):
        self.name = name
        self.capacity = capacity
        self.emitted = []
        self.refused = 0

    def feed(self, values):
        """Push values through a window of `capacity`, collecting what emerges."""
        window = []
        for value in values:
            window.append(value)
            if len(window) > self.capacity:
                window.pop(0)
            if len(window) == self.capacity:
                self.emitted.append(sum(window) / self.capacity)
        return self.emitted

    def reject(self, reason: str) -> None:
        """Counted, not raised: one bad value must not end the run."""
        self.refused += 1

    def summary(self) -> str:
        return f"{self.name}: {len(self.emitted)} emitted, {self.refused} refused"


def main():
    runner = Runner("latency")
    runner.feed([12.0, 14.0, 11.0, 30.0])
    print(runner.summary())


if __name__ == "__main__":
    main()
