"""Entry point of the demo task runner."""
from app.queue import TaskQueue
from app.worker import Worker


def main():
    queue = TaskQueue()
    queue.push("build")
    queue.push("test")
    worker = Worker(queue)
    worker.run()


if __name__ == "__main__":
    main()
