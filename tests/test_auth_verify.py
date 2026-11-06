"""认证接口回归测试。"""

from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_demo_accounts_can_login_and_invalid_credentials_are_rejected():
    """演示账户可登录，错误密码与未知账户统一返回 401。"""
    admin = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "admin123"},
    )
    assert admin.status_code == 200
    assert admin.json()["display_name"] == "管理员"
    assert admin.json()["role"] == "admin"
    assert admin.json()["token"]

    engineer = client.post(
        "/api/auth/login",
        json={"username": "engineer", "password": "eng123"},
    )
    assert engineer.status_code == 200
    assert engineer.json()["display_name"] == "运维工程师"

    wrong_password = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "wrong"},
    )
    assert wrong_password.status_code == 401
    assert wrong_password.json()["detail"]["message"] == "用户名或密码错误"

    unknown_user = client.post(
        "/api/auth/login",
        json={"username": "nobody", "password": "x"},
    )
    assert unknown_user.status_code == 401


def test_token_verify_and_logout_flow():
    """登录令牌可校验，登出后同一令牌立即失效。"""
    login = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "admin123"},
    )
    token = login.json()["token"]

    valid = client.get("/api/auth/verify", params={"token": token})
    assert valid.status_code == 200
    assert valid.json() == {
        "valid": True,
        "username": "admin",
        "display_name": "管理员",
        "role": "admin",
    }

    invalid = client.get("/api/auth/verify", params={"token": "invalid-token"})
    assert invalid.status_code == 200
    assert invalid.json() == {
        "valid": False,
        "username": None,
        "display_name": None,
        "role": None,
    }

    logout = client.post("/api/auth/logout", params={"token": token})
    assert logout.status_code == 200
    assert logout.json()["status"] == "ok"

    after_logout = client.get("/api/auth/verify", params={"token": token})
    assert after_logout.status_code == 200
    assert after_logout.json()["valid"] is False
