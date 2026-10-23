from ..db import session
from app.models import User


def get_user(user_id):
    with session() as s:
        user = s.get(User, user_id)
        if user is None:
            raise KeyError(user_id)
        return user
