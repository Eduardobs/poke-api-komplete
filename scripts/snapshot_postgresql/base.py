from django.db.backends.postgresql.base import DatabaseWrapper as PostgreSQLDatabaseWrapper


class DatabaseWrapper(PostgreSQLDatabaseWrapper):
    # Hasura exposes PostgreSQL smallint as a distinct GraphQL scalar. Keep
    # public Int columns while Django enforces the upstream field validators.
    data_types = {
        **PostgreSQLDatabaseWrapper.data_types,
        "SmallIntegerField": "integer",
        "PositiveSmallIntegerField": "integer",
    }
