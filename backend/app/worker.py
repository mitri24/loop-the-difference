from rq import Worker

from app.config import get_settings
from app.jobs import QUEUE_NAME, connect
from app.smallbodies import SLOW_QUEUE


def main() -> None:
    settings = get_settings()
    queues = [name.strip() for name in settings.worker_queues.split(",") if name.strip()]
    # No socket timeout: the worker blocks on the queue between jobs.
    Worker(
        queues or [QUEUE_NAME, SLOW_QUEUE],
        connection=connect(settings.redis_url, socket_timeout=None),
    ).work()


if __name__ == "__main__":
    main()
