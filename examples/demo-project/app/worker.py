"""Drains the queue and executes each task."""
from app.queue import TaskQueue


class Worker:
    def __init__(self, queue: TaskQueue):
        self.queue = queue
        self.done = 0

    def run(self):
        while self.queue.size() > 0:
            task = self.queue.pop()
            self.execute(task)

    def execute(self, task: str):
        print(f"executing {task}")
        self.done += 1
