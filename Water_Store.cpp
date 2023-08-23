#include <iostream>
#include <algorithm>
using namespace std;

int main() {
    int arr[] = {1, 8, 6, 2, 5, 4, 8, 3, 7};
    int n = sizeof(arr) / sizeof(arr[0]);
    int maxArea = 0;

    // Outer loop: Consider each line as the left side of the container
    for (int i = 0; i < n; i++) {
        // Inner loop: Consider each line as the right side of the container
        for (int j = i + 1; j < n; j++) {
            // Calculate the minimum height of the two lines
            int minHeight = min(arr[i], arr[j]);

            // Calculate the width (distance between indices)
            int width = j - i;

            // Calculate the area formed by the two lines and width
            int area = width * minHeight;

            // Update maxArea with the maximum area found so far
            maxArea = max(maxArea, area);
        }
    }

    // Print the maximum amount of water the container can store
    cout << "Maximum amount of water the container can store: " << maxArea << endl;

    return 0;
}
