"""A tiny FIFO task queue with basic stats."""


class TaskQueue:
    def __init__(self):
        self.items = []
        self.pushed = 0

    def push(self, task: str):
        self.items.append(task)
        self.pushed += 1

    def pop(self) -> str:
        return self.items.pop(0) if self.items else ""

    def size(self) -> int:
        return len(self.items)
