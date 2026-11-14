from rq import Worker

from app.config import get_settings
from app.jobs import QUEUE_NAME, connect


def main() -> None:
    settings = get_settings()
    # No socket timeout: the worker blocks on the queue between jobs.
    Worker([QUEUE_NAME], connection=connect(settings.redis_url, socket_timeout=None)).work()


if __name__ == "__main__":
    main()
