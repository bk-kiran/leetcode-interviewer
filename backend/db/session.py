import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

engine = create_engine(os.environ["DATABASE_URL"], pool_pre_ping=True)
# expire_on_commit=False: without it, every attribute access after a commit
# silently issues a fresh SELECT to repopulate expired attributes. Against a
# remote DB each of those hidden round trips costs real latency, and they add
# up fast across create/update helpers that read attributes back after commit.
SessionLocal = sessionmaker(autocommit=False, autoflush=False, expire_on_commit=False, bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
