import matplotlib.pyplot as plt

# Data from NCES report (in millions)
years = [2000, 2010, 2021, 2030]
enrollment = [13.2, 15.7, 13.3, 16.7]  # 2030 is projected

plt.figure(figsize=(10, 6))
plt.plot(years, enrollment, marker='o', linestyle='-', color='b', label='Total Enrollment')
plt.title('U.S. Undergraduate Enrollment (2000-2030)')
plt.xlabel('Year')
plt.ylabel('Enrollment (Millions)')
plt.grid(True)
plt.legend()
plt.xticks(years)
plt.tight_layout()
plt.show()