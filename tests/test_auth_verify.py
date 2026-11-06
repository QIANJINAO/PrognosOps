# 登录流程验证脚本(临时验证用)
# 验证:登录成功/失败、令牌校验、登出

import json
import urllib.error
import urllib.request

BASE = "http://localhost:8080"


def post(path, payload):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=5) as r:
        return r.status, json.loads(r.read().decode())


# 1. 正确账号登录
status, data = post("/api/auth/login", {"username": "admin", "password": "admin123"})
print(f"[1] 正确账号登录: status={status}, user={data.get('display_name')}, role={data.get('role')}")
assert status == 200 and data.get("token"), "登录应成功"
token = data["token"]

# 2. 错误密码登录
status, data = post("/api/auth/login", {"username": "admin", "password": "wrong"})
print(f"[2] 错误密码登录: status={status}, message={data.get('detail', {}).get('message')}")
assert status == 401, "错误密码应返回 401"

# 3. 不存在的账号
status, data = post("/api/auth/login", {"username": "nobody", "password": "x"})
print(f"[3] 不存在账号登录: status={status}")
assert status == 401, "不存在账号应返回 401"

# 4. 第二个演示账号
status, data = post("/api/auth/login", {"username": "engineer", "password": "eng123"})
print(f"[4] engineer 账号登录: status={status}, user={data.get('display_name')}")
assert status == 200, "engineer 应能登录"

# 5. 令牌校验(有效)
status, data = get("/api/auth/verify?token=" + token)
print(f"[5] 有效令牌校验: status={status}, valid={data.get('valid')}, user={data.get('display_name')}")
assert data.get("valid") is True, "令牌应有效"

# 6. 令牌校验(无效)
status, data = get("/api/auth/verify?token=invalid-token")
print(f"[6] 无效令牌校验: status={status}, valid={data.get('valid')}")
assert data.get("valid") is False, "无效令牌应返回 valid=False"

# 7. 登出
status, data = post("/api/auth/logout?token=" + token, {})
print(f"[7] 登出: status={status}, message={data.get('message')}")
assert status == 200, "登出应成功"

# 8. 登出后令牌失效
status, data = get("/api/auth/verify?token=" + token)
print(f"[8] 登出后令牌校验: valid={data.get('valid')}")
assert data.get("valid") is False, "登出后令牌应失效"

print("\n全部验证通过 ✓")